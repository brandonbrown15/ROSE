#!/usr/bin/env python3
"""
Trains a "rose" microWakeWord model for Home Assistant Voice PE.

Adapted from alfiedennen/microwakeword-trainer's Colab notebook
(microWakeWord_train_any_wakeword.ipynb) for a local, CPU-only,
disk-constrained environment:
  - No Google Drive mount; everything is local paths.
  - Positive samples ("rose", US + UK phonemes) and confusable negatives
    generated via Piper TTS, same as the notebook.
  - The notebook's negative training data (kahrendt/microwakeword HF
    dataset, ~16GB of pre-computed features) was replaced with a much
    smaller Piper-generated "generic negatives" set (50 common phrases,
    150 samples each) — see docs/wake-word.md for what this trades off.
  - AddBackgroundNoise augmentation removed (no FMA/AudioSet corpora
    downloaded); RIR reverb augmentation kept (MIT RIR dataset, ~1.25GB
    zipped, from https://www.openslr.org/resources/28/rirs_noises.zip).
  - training_steps reduced from [25000, 20000] to [3000, 2000], and the
    training split's repetition/slide_frames reduced from 3/10 to 1/3 —
    the original settings blew 152MB of raw positive audio up into 5.6GB
    of spectrogram features (~37x), which alone exceeded this sandbox's
    disk budget.

Prerequisites this script assumes are already in place (not included in
this repo — see docs/wake-word.md for the full recipe used):
  - kahrendt/microWakeWord cloned somewhere, with its directory importable
    (this script does `from microwakeword.audio... import ...` — either
    run with that repo's path prepended to PYTHONPATH, since its own
    setup.py has a packaging bug that drops the audio/ and layers/
    subpackages, or fix that bug and pip install it properly).
  - Python deps: audiomentations, audio_metadata, datasets==2.21.0 (newer
    versions need torchcodec, which needs an ffmpeg matching its exact
    ABI — pin to 2.21.0 rather than chase that), mmap_ninja, numpy,
    pymicro-features, pyyaml, tensorflow-cpu>=2.16, webrtcvad-wheels,
    ai-edge-litert, tensorboard, soundfile, librosa.
  - Three directories of .wav files next to this script, generated via
    piper-sample-generator (see docs/wake-word.md for the exact commands):
    generated_samples/ (positive "rose" samples), confusable_negatives/,
    generic_negatives/.
  - mit_rirs/ — the extracted MIT RIR dataset above, for reverb
    augmentation.
"""
import os
import shutil
import subprocess
import sys
import traceback
from pathlib import Path

import yaml

os.chdir(os.path.dirname(os.path.abspath(__file__)))

from microwakeword.audio.augmentation import Augmentation
from microwakeword.audio.clips import Clips
from microwakeword.audio.spectrograms import SpectrogramGeneration
from mmap_ninja.ragged import RaggedMmap

OUTPUT_NAME = "rose"
WAKE_WORD = "Rose"
AUTHOR = "ROSE project"
AUTHOR_WEBSITE = "https://github.com/brandonbrown15/rose"
TRAINED_LANGUAGES = ["en"]

PROBABILITY_CUTOFF = 0.85
SLIDING_WINDOW_SIZE = 5
TENSOR_ARENA_SIZE = 50000

# Reduced from the notebook's repetition=3/slide_frames=10 on the training
# split, which blew up 152MB of raw positive audio into 5.6GB of spectrogram
# features (~37x) — far past this sandbox's disk budget. repetition=1,
# slide_frames=3 trades some augmentation diversity for staying in budget.
SPLIT_CONFIG = {
    "training": {"split_name": "train", "repetition": 1, "slide_frames": 3},
    "validation": {"split_name": "validation", "repetition": 1, "slide_frames": 3},
    "testing": {"split_name": "test", "repetition": 1, "slide_frames": 1},
}


def build_features(input_directory, out_root, augmenter):
    clips = Clips(
        input_directory=input_directory,
        file_pattern="*.wav",
        max_clip_duration_s=None,
        remove_silence=True,
        random_split_seed=42,
        split_count=0.1,
    )
    for split, cfg in SPLIT_CONFIG.items():
        out = f"{out_root}/{split}"
        mmap = f"{out}/wakeword_mmap"
        if os.path.exists(mmap) and list(os.scandir(mmap)):
            print(f"  {out_root}/{split}: cached, skipping")
            continue
        if os.path.exists(mmap):
            shutil.rmtree(mmap)
        os.makedirs(out, exist_ok=True)
        print(f"  generating {out_root}/{split} (rep={cfg['repetition']}, slide={cfg['slide_frames']})...")
        try:
            sg = SpectrogramGeneration(
                clips=clips, augmenter=augmenter, slide_frames=cfg["slide_frames"], step_ms=10
            )
            RaggedMmap.from_generator(
                out_dir=mmap,
                batch_size=200,
                verbose=True,
                sample_generator=sg.spectrogram_generator(split=cfg["split_name"], repeat=cfg["repetition"]),
            )
        except Exception:
            traceback.print_exc()
            if os.path.exists(mmap):
                shutil.rmtree(mmap)
            raise


def main():
    augmenter = Augmentation(
        augmentation_duration_s=3.2,
        augmentation_probabilities={
            "SevenBandParametricEQ": 0.15,
            "TanhDistortion": 0.10,
            "PitchShift": 0.15,
            "BandStopFilter": 0.10,
            "AddColorNoise": 0.20,
            # No AddBackgroundNoise: we didn't download FMA/AudioSet
            # (~1GB) to stay within this sandbox's disk budget.
            "Gain": 1.00,
            "GainTransition": 0.25,
            "RIR": 0.60,
        },
        impulse_paths=["mit_rirs"],
        background_paths=[],
        background_min_snr_db=-5,
        background_max_snr_db=20,
        min_jitter_s=0.10,
        max_jitter_s=0.50,
    )

    print("=== Positive features (generated_samples) ===")
    build_features("generated_samples", "generated_augmented_features", augmenter)

    print("=== Confusable-negative features ===")
    build_features("confusable_negatives", "confusable_features", augmenter)

    print("=== Generic-negative features ===")
    build_features("generic_negatives", "generic_negative_features", augmenter)

    print("=== Writing training_parameters.yaml ===")
    config = {
        "window_step_ms": 10,
        "train_dir": f"trained_models/{OUTPUT_NAME}",
        "features": [
            dict(
                features_dir="generated_augmented_features",
                sampling_weight=8.0,
                penalty_weight=2.0,
                truth=True,
                truncation_strategy="truncate_start",
                type="mmap",
            ),
            dict(
                features_dir="confusable_features",
                sampling_weight=10.0,
                penalty_weight=5.0,
                truth=False,
                truncation_strategy="random",
                type="mmap",
            ),
            dict(
                features_dir="generic_negative_features",
                sampling_weight=10.0,
                penalty_weight=2.5,
                truth=False,
                truncation_strategy="random",
                type="mmap",
            ),
        ],
        # Reduced from the notebook's [25000, 20000] for a CPU-only budget.
        "training_steps": [3000, 2000],
        "positive_class_weight": [2, 2],
        "negative_class_weight": [40, 50],
        "learning_rates": [0.001, 0.0001],
        "batch_size": 128,
        "time_mask_max_size": [5, 5],
        "time_mask_count": [1, 1],
        "freq_mask_max_size": [3, 3],
        "freq_mask_count": [1, 1],
        "eval_step_interval": 500,
        "clip_duration_ms": 1500,
        "target_minimization": 0.4,
        "minimization_metric": "ambient_false_positives_per_hour",
        "maximization_metric": "average_viable_recall",
    }
    os.makedirs(f"trained_models/{OUTPUT_NAME}", exist_ok=True)
    with open("training_parameters.yaml", "w") as f:
        yaml.dump(config, f)
    print(f"  total steps: {sum(config['training_steps'])}")

    print("=== Training ===")
    shutil.rmtree(f"trained_models/{OUTPUT_NAME}", ignore_errors=True)
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{os.environ.get('MWW_REPO', '')}:" + env.get("PYTHONPATH", "")
    env["XLA_FLAGS"] = "--xla_gpu_autotune_level=0"
    cmd = [
        sys.executable,
        "-m",
        "microwakeword.model_train_eval",
        "--training_config",
        "training_parameters.yaml",
        "--train",
        "1",
        "--restore_checkpoint",
        "0",
        "--test_tflite_streaming_quantized",
        "1",
        "--use_weights",
        "best_weights",
        "mixednet",
        "--pointwise_filters",
        "64,64,64,64",
        "--repeat_in_block",
        "1, 1, 1, 1",
        "--mixconv_kernel_sizes",
        "[5], [7,11], [9,15], [23]",
        "--residual_connection",
        "0,0,0,0",
        "--first_conv_filters",
        "32",
        "--first_conv_kernel_size",
        "5",
        "--stride",
        "3",
    ]
    print("Running:", " ".join(cmd))
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        print(line, end="")
    proc.wait()
    print("Exit code:", proc.returncode)
    if proc.returncode != 0:
        raise RuntimeError("training failed - see output above")

    print("=== Export ===")
    import json

    tflite_src = f"trained_models/{OUTPUT_NAME}/tflite_stream_state_internal_quant/stream_state_internal_quant.tflite"
    if not os.path.exists(tflite_src):
        raise RuntimeError(f"No model at {tflite_src}")
    out_tflite = f"{OUTPUT_NAME}.tflite"
    out_json = f"{OUTPUT_NAME}.json"
    shutil.copy2(tflite_src, out_tflite)
    print(f"wrote {out_tflite} ({os.path.getsize(out_tflite) / 1024:.1f} KB)")

    manifest = {
        "type": "micro",
        "wake_word": WAKE_WORD,
        "author": AUTHOR,
        "website": AUTHOR_WEBSITE,
        "model": out_tflite,
        "trained_languages": TRAINED_LANGUAGES,
        "version": 2,
        "micro": {
            "probability_cutoff": PROBABILITY_CUTOFF,
            "feature_step_size": 10,
            "sliding_window_size": SLIDING_WINDOW_SIZE,
            "tensor_arena_size": TENSOR_ARENA_SIZE,
            "minimum_esphome_version": "2024.7.0",
        },
    }
    with open(out_json, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"wrote {out_json}")
    print(json.dumps(manifest, indent=2))
    print("DONE")


if __name__ == "__main__":
    main()

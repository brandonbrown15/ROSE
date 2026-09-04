-- A household-wide PIN gating high-risk device actions (unlocking a lock,
-- disarming the alarm) — see chat.ts's HIGH_RISK_SERVICES and
-- households.ts's setHouseholdPin/verifyHouseholdPin. Identity in ROSE is
-- otherwise entirely self-reported (see docs/memory.md's "Future: real
-- voice identification" section) — anyone who says "this is Dad, unlock
-- the door" is believed. The PIN is a second factor specifically for the
-- handful of actions where that trust model isn't good enough, independent
-- of who the conversation currently thinks is speaking.
--
-- Never stored in plaintext: admin_pin_hash is a PBKDF2-SHA256 digest of
-- the PIN salted with admin_pin_salt (see households.ts). Both NULL means
-- no PIN has been set up yet for that household — verifyHouseholdPin falls
-- back to a documented default (currently "1003") rather than refusing
-- outright, so a household isn't locked out of unlock/disarm before
-- anyone's had a chance to set a real PIN. See docs/cloudflare.md.
ALTER TABLE households ADD COLUMN admin_pin_hash TEXT;
ALTER TABLE households ADD COLUMN admin_pin_salt TEXT;

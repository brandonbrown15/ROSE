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
-- no PIN has been set up yet for that household — chat.ts treats that as
-- "deny all high-risk actions", not "allow them", so a household is never
-- silently unprotected.
ALTER TABLE households ADD COLUMN admin_pin_hash TEXT;
ALTER TABLE households ADD COLUMN admin_pin_salt TEXT;

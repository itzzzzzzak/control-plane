-- Pure PostgreSQL integration smoke test; fails if lease functions are broken.
BEGIN;
DO $$
DECLARE
  first_token uuid;
  first_epoch bigint;
  other_token uuid;
  next_epoch bigint;
  acquired integer;
  until_time timestamptz;
BEGIN
  SELECT token, epoch INTO first_token, first_epoch
    FROM syncore_claim_lease('gate2-sql-test', 10000);
  IF first_token IS NULL OR first_epoch <> 1 THEN
    RAISE EXCEPTION 'first lease should be epoch 1';
  END IF;
  SELECT count(*) INTO acquired FROM syncore_claim_lease('gate2-sql-test', 10000);
  IF acquired <> 0 THEN RAISE EXCEPTION 'competing acquire should be busy'; END IF;
  PERFORM syncore_assert_lease('gate2-sql-test', first_token, first_epoch);
  until_time := syncore_renew_lease('gate2-sql-test', first_token, first_epoch, 10000);
  IF until_time IS NULL THEN RAISE EXCEPTION 'valid renewal must succeed'; END IF;
  IF syncore_release_lease('gate2-sql-test', gen_random_uuid(), first_epoch) THEN
    RAISE EXCEPTION 'wrong owner must not release';
  END IF;
  IF NOT syncore_release_lease('gate2-sql-test', first_token, first_epoch) THEN
    RAISE EXCEPTION 'owner release should succeed';
  END IF;
  SELECT token, epoch INTO other_token, next_epoch
    FROM syncore_claim_lease('gate2-sql-test', 10000);
  IF next_epoch <> 2 OR other_token = first_token THEN
    RAISE EXCEPTION 'epoch not advanced on claim';
  END IF;
  IF syncore_release_lease('gate2-sql-test', first_token, first_epoch) THEN
    RAISE EXCEPTION 'stale owner released successor';
  END IF;
  IF syncore_renew_lease('gate2-sql-test', first_token, first_epoch, 10000) IS NOT NULL THEN
    RAISE EXCEPTION 'stale owner renewed';
  END IF;
  -- Force a lease expiry using the database clock; no timing-dependent sleeps.
  UPDATE syncore_leases SET expires_at = clock_timestamp() - interval '1 second'
    WHERE sync_name = 'gate2-sql-test';
  IF syncore_renew_lease('gate2-sql-test', other_token, next_epoch, 10000) IS NOT NULL THEN
    RAISE EXCEPTION 'expired lease renewed';
  END IF;
  -- Check a stale owner cannot pass commit fencing, without aborting the outer test.
  BEGIN
    PERFORM syncore_assert_lease('gate2-sql-test', other_token, next_epoch);
    RAISE EXCEPTION 'expired owner bypassed fence';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL; -- expected fenced-owner exception
  END;
  SELECT token, epoch INTO other_token, next_epoch
    FROM syncore_claim_lease('gate2-sql-test', 10000);
  IF next_epoch <> 3 THEN RAISE EXCEPTION 'expiry takeover did not advance epoch'; END IF;
END;
$$;
ROLLBACK;

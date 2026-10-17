-- Gate 2 migration 002: atomic DB-time lease operations.
-- Intended for a dedicated application DB role with restricted schema privileges.
CREATE OR REPLACE FUNCTION syncore_claim_lease(p_sync text, p_ttl_ms bigint)
RETURNS TABLE(token uuid, epoch bigint, expires_at timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  current_lease syncore_leases%ROWTYPE;
  at_time timestamptz;
BEGIN
  IF p_sync = '' OR p_ttl_ms < 1 OR p_ttl_ms > 86400000 THEN
    RAISE EXCEPTION 'invalid sync or TTL';
  END IF;
  INSERT INTO syncore_leases(sync_name) VALUES (p_sync)
  ON CONFLICT (sync_name) DO NOTHING;
  SELECT * INTO current_lease FROM syncore_leases
    WHERE sync_name = p_sync FOR UPDATE;
  at_time := clock_timestamp();
  IF current_lease.token IS NOT NULL AND current_lease.expires_at > at_time THEN
    RETURN;
  END IF;
  UPDATE syncore_leases l
    SET epoch = l.epoch + 1,
        token = gen_random_uuid(),
        expires_at = at_time + p_ttl_ms * interval '1 millisecond'
    WHERE l.sync_name = p_sync
    RETURNING l.token, l.epoch, l.expires_at INTO token, epoch, expires_at;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION syncore_renew_lease(
  p_sync text, p_token uuid, p_epoch bigint, p_ttl_ms bigint
)
RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE new_expiry timestamptz;
BEGIN
  IF p_ttl_ms < 1 OR p_ttl_ms > 86400000 THEN RAISE EXCEPTION 'invalid TTL'; END IF;
  UPDATE syncore_leases
    SET expires_at = clock_timestamp() + p_ttl_ms * interval '1 millisecond'
    WHERE sync_name = p_sync AND token = p_token AND epoch = p_epoch
      AND expires_at > clock_timestamp()
    RETURNING expires_at INTO new_expiry;
  RETURN new_expiry;
END;
$$;

CREATE OR REPLACE FUNCTION syncore_release_lease(
  p_sync text, p_token uuid, p_epoch bigint
)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
  UPDATE syncore_leases SET token = NULL, expires_at = NULL
  WHERE sync_name = p_sync AND token = p_token AND epoch = p_epoch
    AND expires_at > clock_timestamp();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

-- Call inside the SAME transaction that writes rows, dead letters, and checkpoint.
-- The FOR UPDATE row lock holds until the transaction commits or rolls back.
-- Call this check after all asynchronous page preparation, immediately before DB writes.
CREATE OR REPLACE FUNCTION syncore_assert_lease(
  p_sync text, p_token uuid, p_epoch bigint
)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE held boolean;
BEGIN
  SELECT (token = p_token AND epoch = p_epoch AND expires_at > clock_timestamp())
    INTO held FROM syncore_leases WHERE sync_name = p_sync FOR UPDATE;
  IF held IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sync lease lost or fenced' USING ERRCODE = '55000';
  END IF;
END;
$$;

-- Integrity rules not expressible in the Prisma schema (see docs/architecture/data-model.md).

-- Public OGC IDs: canonical random 9-digit format (ADR-008).
ALTER TABLE "users" ADD CONSTRAINT "users_ogc_id_format"
    CHECK ("ogc_id" ~ '^OGC[1-9][0-9]{8}$');

-- Emails are stored normalised, so the unique index is effectively case-insensitive.
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalised"
    CHECK ("email" = lower(btrim("email")) AND length("email") >= 3);

ALTER TABLE "profiles" ADD CONSTRAINT "profiles_display_name_not_blank"
    CHECK (length(btrim("display_name")) > 0);

ALTER TABLE "credentials" ADD CONSTRAINT "credentials_failed_login_count_non_negative"
    CHECK ("failed_login_count" >= 0);

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_expiry_after_creation"
    CHECK ("expires_at" > "created_at");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revocation_consistent"
    CHECK (("revoked_at" IS NULL) = ("revocation_reason" IS NULL));

ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_expiry_after_creation"
    CHECK ("expires_at" > "created_at");

-- A public OGC ID can never change once issued.
CREATE FUNCTION "ogc_reject_ogc_id_change"() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."ogc_id" IS DISTINCT FROM OLD."ogc_id" THEN
        RAISE EXCEPTION 'ogc_id is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "users_ogc_id_immutable"
    BEFORE UPDATE OF "ogc_id" ON "users"
    FOR EACH ROW EXECUTE FUNCTION "ogc_reject_ogc_id_change"();

-- The audit log is append-only.
CREATE FUNCTION "ogc_reject_audit_mutation"() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "audit_events_append_only"
    BEFORE UPDATE OR DELETE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION "ogc_reject_audit_mutation"();

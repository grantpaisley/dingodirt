-- Plan publishes packs to dingodirt.com instead of the dingo-shares repo
-- (docs/plans/2026-08-06-plan-publish-to-dingodirt-design.md).
--
-- app_settings is a tiny key/value store for runtime-supplied config the env
-- can't carry — first user: the pasted dingodirt.com API token.
CREATE TABLE app_settings (
    key   text PRIMARY KEY,
    value text NOT NULL
);

-- A published pack's identity on the site. site_pack_id pins version bumps
-- (renames propagate instead of forking); share_token drives the ?b= link;
-- site_visibility mirrors the site's state as of the last publish. The old
-- slug column stays for now but nothing writes it anymore.
ALTER TABLE packs
    ADD COLUMN site_pack_id    text,
    ADD COLUMN share_token     text,
    ADD COLUMN site_visibility text;

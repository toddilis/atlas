-- TENANT-01c: cross-business references become unrepresentable. 33 foreign keys between
-- org-scoped tables referenced only the target's id, so the DATABASE permitted a row in
-- one business to point at another business's invoice, account, product, ledger entry or
-- event — only the entry points' resolve-within-org discipline prevented it. Every such
-- foreign key now carries org_id, matching the composite shape 0021/0029 already used
-- for dispatch data, so an unscoped reference fails the constraint itself.
--
-- The sweep is mechanical and preserves each constraint exactly: the target gains
-- unique (org_id, <col>) where no equivalent unique/primary key exists, and the foreign
-- key is recreated as (org_id, <col>) with its original delete/update action and
-- deferrability. ON DELETE SET NULL uses the PG15+ column list so org_id (not null)
-- is never nulled. Existing rows all satisfy the new constraints (references were
-- already same-org in every business); scripts/verify-tenant-surface.sql now asserts
-- the surface stays closed, so a future migration cannot reintroduce an unscoped
-- reference without failing CI by name.

do $$
declare
  r record; v_actions text;
begin
  for r in
    select c.conname, src.oid as srcoid, src.relname as src, tgt.oid as tgtoid, tgt.relname as tgt,
           (select a.attname from pg_attribute a where a.attrelid=c.conrelid and a.attnum=c.conkey[1]) as srccol,
           (select a.attname from pg_attribute a where a.attrelid=c.confrelid and a.attnum=c.confkey[1]) as tgtcol,
           c.confdeltype, c.confupdtype, c.condeferrable, c.condeferred
      from pg_constraint c
      join pg_class src on src.oid=c.conrelid
      join pg_class tgt on tgt.oid=c.confrelid
      join pg_namespace n on n.oid=src.relnamespace
     where n.nspname='public' and c.contype='f' and array_length(c.conkey,1)=1
       and exists(select 1 from pg_attribute where attrelid=src.oid and attname='org_id' and attnum>0 and not attisdropped)
       and exists(select 1 from pg_attribute where attrelid=tgt.oid and attname='org_id' and attnum>0 and not attisdropped)
     order by src.relname, c.conname
  loop
    -- The composite target: unique (org_id, col), unless an equivalent unique or
    -- primary key (as a column set) already exists.
    if not exists (
      select 1 from pg_constraint u
       where u.conrelid=r.tgtoid and u.contype in ('u','p')
         and (select array_agg(a.attname order by a.attname)
                from unnest(u.conkey) k(attnum)
                join pg_attribute a on a.attrelid=u.conrelid and a.attnum=k.attnum)
             = (select array_agg(x order by x) from unnest(array['org_id'::name, r.tgtcol::name]) x)
    ) then
      execute format('alter table %I add constraint %I unique (org_id, %I)',
        r.tgt, left(r.tgt||'_org_'||r.tgtcol||'_key', 63), r.tgtcol);
    end if;

    v_actions :=
      case r.confdeltype
        when 'c' then ' on delete cascade'
        when 'r' then ' on delete restrict'
        when 'n' then format(' on delete set null (%I)', r.srccol)
        when 'd' then format(' on delete set default (%I)', r.srccol)
        else '' end ||
      case r.confupdtype
        when 'c' then ' on update cascade'
        when 'r' then ' on update restrict'
        else '' end ||
      case when r.condeferrable then ' deferrable' || case when r.condeferred then ' initially deferred' else '' end else '' end;

    execute format('alter table %I drop constraint %I', r.src, r.conname);
    execute format('alter table %I add constraint %I foreign key (org_id, %I) references %I (org_id, %I)%s',
      r.src, r.conname, r.srccol, r.tgt, r.tgtcol, v_actions);
  end loop;
end $$;

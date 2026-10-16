-- Only the disposable auth workflow calls this synthetic fixture.
insert into orgs(id,slug,display_name) values
 ('11111111-1111-4111-8111-111111111111','auth-browser','Auth browser fixture'),
 ('22222222-2222-4222-8222-222222222222','auth-other','Other synthetic business');
insert into invoices(org_id,invoice_number,state,currency,subtotal_cents,total_cents) values
 ('11111111-1111-4111-8111-111111111111','AUTH-ALLOWED-001','draft','NZD',1000,1000),
 ('22222222-2222-4222-8222-222222222222','AUTH-OTHER-SECRET-001','draft','NZD',2000,2000);
grant usage on schema public to service_role;
grant select on all tables in schema public to service_role;
notify pgrst, 'reload schema';

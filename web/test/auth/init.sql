-- Disposable container only: separate search paths keep GoTrue's unqualified
-- runtime queries in auth while Atlas migrations and PostgREST remain in public.
create role auth_test login superuser password 'disposable-auth-only';
create schema if not exists auth authorization auth_test;
alter role auth_test set search_path = auth, public;

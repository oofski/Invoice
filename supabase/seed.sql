-- =====================================================================
-- InvoiceIQ — Seed data (Brief §02 location dictionary, §03 users,
-- §05 vendor routing lists).
--
-- HOW TO USE:
--  1. Run AFTER 0001_schema.sql / 0002_rls.sql / 0003_auth_trigger.sql.
--  2. EDIT the placeholder emails below to the client's real addresses
--     BEFORE inviting users — the magic-link login links an auth account to
--     a seeded profile by matching email (see handle_new_user trigger).
-- =====================================================================

-- ---------------------------------------------------------------------
-- USERS  (1 accountant, 6 executives, 1 admin) — EDIT EMAILS BEFORE USE
-- ---------------------------------------------------------------------
insert into users (name, email, role, entity_access) values
  ('Accountant',  'accountant@example.com', 'accountant', null),
  ('Admin',       'admin@example.com',      'admin',      null),
  ('Lori',        'lori@example.com',       'executive',  null),
  ('Lisa',        'lisa@example.com',       'executive',  null),
  ('Kari',        'kari@example.com',       'executive',  null),
  ('Bonnie',      'bonnie@example.com',     'executive',  null),
  ('Susan',       'susan@example.com',      'executive',  null),
  ('Exec Six',    'exec6@example.com',      'executive',  null)
on conflict (email) do nothing;

-- ---------------------------------------------------------------------
-- LOCATION MAPPINGS  (Brief §02)
-- ---------------------------------------------------------------------
insert into location_mappings (address, keywords, business, class, default_approver) values
  ('10902 N Port Washington', array['10902 N Port Washington','Mequon'],                       'Neroli',  'Mequon',      'Lori'),
  ('327 E St Paul',           array['327 E St Paul','Downtown'],                                'Neroli',  'Downtown',    'Lori'),
  ('1919 E Kenilworth',       array['1919 E Kenilworth','Eastside'],                            'Neroli',  'Eastside',    'Lori'),
  ('200 W Silver Spring',     array['200 W Silver Spring','North Shore'],                       'Neroli',  'North Shore', 'Lori'),
  ('3885 N Brookfield',       array['3885 N Brookfield','Brookfield'],                          'Neroli',  'Brookfield',  'Lori'),
  ('4005 N Downer',           array['4005 N Downer','Shorewood'],                               'SKNBar',  'Shorewood',   'Lisa'),
  ('145 W Wisconsin',         array['145 W Wisconsin','Pewaukee'],                              'SKNBar',  'Pewaukee',    'Lisa'),
  ('327 E St Paul 5th Floor', array['327 E St Paul 5th Floor','IBW-Milwaukee','IBW Milwaukee'], 'IBW',     'Milwaukee',   'Kari'),
  ('7021 Tree Ln',            array['7021 Tree Ln','IBW-Madison','IBW Madison','Madison'],       'IBW',     'Madison',     'Kari'),
  ('2828 N Clark St',         array['2828 N Clark St','Chicago'],                               'Chicago', 'Chicago',     'Bonnie'),
  ('Admin / Corporate',       array['Admin','Corporate','Nala'],                                'Admin',   'None',        'None')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- VENDOR MAPPINGS  (Brief §05 routing vendor lists). default_approver is a
-- hint only — Prompt 2 makes the final routing decision with full context.
-- gl_override left null: fill in the authoritative vendor->GL map via the
-- Vendor Mapping Manager UI.
-- ---------------------------------------------------------------------
insert into vendor_mappings (vendor_name, business_entity, class, default_approver, is_inventory, gl_override) values
  -- Rule 2 (IBW/Chicago) -> Lisa
  ('Pivot Point',    'IBW',     null, 'Lisa', true,  null),
  ('FROMM',          'IBW',     null, 'Lisa', true,  null),
  ('Ultraceuticals', 'IBW',     null, 'Lisa', true,  null),
  ('Cohere',         'IBW',     null, 'Lisa', false, null),
  ('CTC Supplies',   null,      null, 'Lisa', true,  null),
  ('Marlo',          null,      null, 'Lisa', true,  null),
  ('Concordance',    null,      null, 'Lisa', true,  null),
  ('Cintas',         null,      null, 'Lisa', false, null),
  -- Rule 3 (IBW/Chicago) -> Kari
  ('Avellas',        'IBW',     null, 'Kari', false, null),
  ('Culligan',       'IBW',     null, 'Kari', false, null),
  ('Imaginal Group', 'IBW',     null, 'Kari', false, null),
  ('Salescomm',      'IBW',     null, 'Kari', false, null),
  ('West Place LLC', 'IBW',     null, 'Kari', false, null),
  -- Rule 4 (Neroli/SKNBar) -> Lori
  ('Colectivo',      'Neroli',  null, 'Lori', false, null),
  -- Rule 5 -> Bonnie (Admin/Corporate vendors)
  ('Beautiful Clean','Admin',   null, 'Bonnie', false, null),
  ('STAMM',          'Admin',   null, 'Bonnie', false, null),
  ('WASH',           'Admin',   null, 'Bonnie', false, null),
  ('CSC LLC',        'Admin',   null, 'Bonnie', false, null),
  ('UKG',            'Admin',   null, 'Bonnie', false, null),
  ('Brixmor',        'Admin',   null, 'Bonnie', false, null),
  ('Delta Dental',   'Admin',   null, 'Bonnie', false, null),
  ('FISH',           'Admin',   null, 'Bonnie', false, null),
  ('Gordon Flesch',  'Admin',   null, 'Bonnie', false, null),
  ('TOGO',           'Admin',   null, 'Bonnie', false, null),
  ('Guthrie & Frey', 'Admin',   null, 'Bonnie', false, null),
  ('Global Sight',   'Admin',   null, 'Bonnie', false, null),
  ('Adelman',        'Admin',   null, 'Bonnie', false, null)
on conflict (vendor_name) do nothing;

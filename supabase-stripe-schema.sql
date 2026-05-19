-- Supabase tables for Stripe separate charges + transfer hold flow

-- Trusted cards table stores a fingerprint once a card is trusted.
create table if not exists trusted_cards (
  fingerprint text primary key,
  created_at timestamptz not null default now()
);

-- Pending transfers table holds transfers delayed by the fraud hold.
create table if not exists pending_transfers (
  id uuid primary key default gen_random_uuid(),
  amount_cents integer not null,
  currency text not null,
  destination_account text not null,
  unlock_date timestamptz not null,
  status text not null check (status in ('pending', 'completed')),
  stripe_charge_id text unique,
  stripe_transfer_id text,
  payment_intent_id text,
  recipient_user_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

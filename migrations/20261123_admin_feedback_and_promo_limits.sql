ALTER TABLE public.lexo_feedback ADD COLUMN resolved_at timestamptz;
ALTER TABLE public.lexo_promos ADD COLUMN expires_at timestamptz,
  ADD COLUMN max_uses integer CHECK (max_uses > 0);
CREATE INDEX lexo_redemptions_code_idx ON public.lexo_redemptions(code);

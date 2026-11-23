CREATE TABLE public.lexo_prices (
  plan text PRIMARY KEY CHECK (plan IN ('plus','pro')),
  stars integer NOT NULL CHECK (stars BETWEEN 0 AND 10000 AND (plan = 'plus' OR stars > 0))
);
INSERT INTO public.lexo_prices(plan,stars) VALUES ('plus',0),('pro',1);
ALTER TABLE public.lexo_prices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lexo_prices FROM anon, authenticated;
ALTER TABLE public.lexo_orders
  ADD COLUMN plan text NOT NULL DEFAULT 'pro' CHECK (plan IN ('plus','pro')),
  ADD COLUMN stars integer NOT NULL DEFAULT 1 CHECK (stars BETWEEN 1 AND 10000);

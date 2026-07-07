import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_AIRLAB_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_AIRLAB_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

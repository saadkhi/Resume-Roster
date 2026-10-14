import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseKey);

export async function fetchTodos() {
  try {
    const { data, error } = await supabase.from('todos').select('*');
    if (error) {
      console.warn('[Supabase] fetchTodos notice:', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.warn('[Supabase] error:', err.message);
    return [];
  }
}

export default supabase;

# Resume Rater (RR)

Career Intelligence & ATS Resume Evaluation Engine that parses resumes, extracts CV sections, predicts candidate category, and computes multi-dimensional match similarity against target job descriptions.

## 100% Free & Open Platform
- **Zero Subscriptions:** All paywalls and subscription restrictions have been completely removed.
- **Unlimited ATS Scans:** Parse unlimited PDF & DOCX resumes with full TF-IDF vector space scoring.
- **Visual Analytics:** Interactive Recharts 5-point competency radar and real-time keyword gap diagnostics.
- **Supabase Authentication:** Seamless single sign-on with Google, GitHub, and Microsoft via Supabase Auth.
- **Supabase PostgreSQL Cloud Database:** Direct data persistence for candidate evaluations, parsed sections, and user records.

## Database Configuration (Supabase PostgreSQL)
- **Host:** `db.medvnbynodmsjaqvtjzl.supabase.co`
- **Port:** `5432`
- **Database:** `postgres`
- **User:** `postgres`
- **Connection String:** `postgresql://postgres:[YOUR-PASSWORD]@db.medvnbynodmsjaqvtjzl.supabase.co:5432/postgres`
- **Supabase Project URL:** `https://medvnbynodmsjaqvtjzl.supabase.co`

### Environment Variables
Configure your database password in `.env.local` or `.env`:
```bash
SUPABASE_DB_HOST=db.medvnbynodmsjaqvtjzl.supabase.co
SUPABASE_DB_PORT=5432
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=postgres
SUPABASE_DB_PASSWORD=[YOUR-PASSWORD]
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.medvnbynodmsjaqvtjzl.supabase.co:5432/postgres
NEXT_PUBLIC_SUPABASE_URL=https://medvnbynodmsjaqvtjzl.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_sZf5iUHaHsorwnonRdoC0g_gtthy4-f
```

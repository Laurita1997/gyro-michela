# Gyro with Michela (Studio Sign Up)

Booking page for Michela's gyro sessions. Clients send a request, Michela accepts, suggests another time, or declines.

- `index.html`: the whole front end (deployed on Vercel)
- `supabase/functions/api/index.ts`: the Supabase Edge Function (shared data, server-side code check)
- Database: one locked table `booking_state` (RLS on, no policies, only the function can read or write)

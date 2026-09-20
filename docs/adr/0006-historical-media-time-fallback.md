# Rebuild historical media times with a declared fallback

Status: accepted

When rebuilding the Chat Image Library, CFL uses a restored Human message's original time only when retained conversation evidence verifies it. If that evidence is unavailable, affected Historical media receives the synthetic local-calendar date 2026-09-01 and preserves imported conversation order through monotonic within-day timestamps. This is a catalogue-ordering policy, not a claim that the Human sent media on that date: it neither changes message state or image bytes nor guesses from service-start or filesystem times, while keeping current Human and Agent media on the newest gallery page.

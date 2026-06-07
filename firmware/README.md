# nRF9160 Firmware (Zephyr)

This is a starter app for the nRF9160 DK. It:
- Reads the ultrasonic sensor every 30 minutes
- Applies a median filter across several pings
- Uploads the reading via HTTP to the server
- Caches recent readings in RAM if upload fails

## Setup

1. Install the nRF Connect SDK (Zephyr).
2. Build for the nRF9160 DK:
   - `west build -b nrf9160dk_nrf9160_ns .`
3. Flash:
   - `west flash`

## Pins

Update `TRIG_PIN` and `ECHO_PIN` in `src/main.c` to match your wiring.

## Notes

- The cache is RAM only right now. Once mounted and validated, we can add
  flash-backed storage to survive power loss.
- HTTP is plain text for now. We'll switch to HTTPS once the domain is final.

# thermal-agent

Streams a **Fluke iSee TC01A** thermal camera from the laptop it is plugged into to:

- the **Synced Capture** page, `https://thermal.18.61.179.93.sslip.io/thermal-sync/`. One button captures
  the webcam and the thermal camera together, as a photo or as a 5 s / 10 s video.
- the **Thermal Capture** page, `https://thermal.18.61.179.93.sslip.io/thermal/` → Thermal → **Live**.

- Reads the camera with the community, unofficial [`tc01a`](https://github.com/dazchi/tc01a-python)
  driver (MIT; libusb, no vendor SDK), pinned in `requirements.txt`.
- Serves `http://127.0.0.1:8765` (Chrome) and `https://localhost:8766` (Safari) on this laptop only,
  and answers only the Thermal page's origin. Needs agent **0.3.0 or later** for Safari.
- Sends full 256×192 temperature maps in °C; the page uploads them together with the RGB photo.
- Records thermal clips for the video mode (`/record.npz`, 10 frames/s, 0.01 °C steps). Needs agent
  **0.2.0 or later**. If the page says the agent is too old, run the two `curl` lines below again.

## macOS setup (once)

```bash
# 1. Homebrew packages
brew install python@3.12 libusb

# 2. Get the agent
mkdir -p ~/thermal-agent && cd ~/thermal-agent
curl -fsSLO https://thermal.18.61.179.93.sslip.io/agent/thermal_agent.py
curl -fsSLO https://thermal.18.61.179.93.sslip.io/agent/requirements.txt

# 3. Python environment
/opt/homebrew/bin/python3.12 -m venv .venv      # Intel Macs: /usr/local/bin/python3.12
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
```

## Run

```bash
cd ~/thermal-agent
.venv/bin/python thermal_agent.py --demo         # test without the camera
sudo .venv/bin/python thermal_agent.py           # with the TC01A plugged in
```

macOS's own camera driver holds the TC01A, so the real camera usually needs `sudo`.

Options: `--rotate 0|90|180|270` (also a button on the page), `--emissivity 0.98`
(default, human skin), `--port 8765`, `--https-port 8766` (0 = off), `-v` for verbose logs.

## Safari (once)

Safari reaches the agent over HTTPS on port 8766, so it needs a certificate for `localhost`. On the
first run the agent creates one in `~/thermal-agent/certs/`. It is valid only for `localhost` and
`127.0.0.1` and cannot vouch for any other site, and its private key stays on this Mac. To trust it
(enter your Mac password):

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/thermal-agent/certs/localhost.pem
```

Then quit and reopen Safari. In Safari the pages fill in `https://localhost:8766` as the agent address
automatically. To check the certificate, open <https://localhost:8766/status> in Safari: you should see a
line of JSON, not "This connection is not private".

To undo: open Keychain Access → System → delete "thermal-agent localhost". Running with
`--https-port 0` turns the Safari port off.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Page: "Could not reach thermal-agent" | Agent not running, page not in **Chrome**, or Chrome's "access other apps and services on this device" prompt was blocked — allow it in the site settings (padlock icon). |
| Agent: `no TC01A found` | Re-plug the camera; use a data-capable USB-C cable/adapter. |
| Agent: `cannot open device` / access error | Run with `sudo`. Quit any app using the camera. |
| Image sideways / upside down | Press **Rotate** on the page (or start with `--rotate 90`). |
| Safari: "Could not reach thermal-agent" | Use `https://localhost:8766` as the address, check the agent says 0.3.0, and trust the certificate (above). Then quit and reopen Safari. |
| Agent: "Safari port disabled" | Run `.venv/bin/pip install -r requirements.txt` again (it adds `cryptography`). |
| Temperatures drift | Press **Recalibrate** (shutter) and wait a second before capturing. |

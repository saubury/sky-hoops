# Sky Hoops

An arcade game played over real air traffic. Recorded ADS-B flight tracks
around Sydney Airport replay in 3D; you throw hoops ahead of the aircraft and
score when the real flight goes through them.

**Play it: https://simonaubury.com/sky-hoops/**

## How to play

- **Press and hold** on an aircraft or its label to wind up a hoop. The longer
  you hold, the further ahead it lands (15–100 seconds of flight) and the more
  it is worth. **Release** to throw.
- The hoop sits where the aircraft would be if it kept flying straight. The
  recorded track decides whether it goes through, so read the trail: a steady
  approach is a safe bet, a trainer in the circuit is about to turn.
- Chain hits for a streak multiplier, fill the bar for **FEVER** (double
  points), thread the centre for a **bullseye**, and catch the **golden
  plane** for triple.
- **Tower calls** ("hoop a wide-body", "hoop an overseas airline") pay triple
  for a matching aircraft. Labels only show a callsign and an ICAO type code,
  so it helps to know your fleet.
- The tower reads its calls out loud, along with golden planes, streaks,
  time checks and your final score, using your browser's built-in speech
  voice (Australian if your device has one).
- A round is two minutes. Drag to look around, scroll to zoom.

| Key | Action |
|---|---|
| `Space` | Start / play again |
| `M` | Sound on / off |
| `V` | Tower voice on / off |
| `N` | Day / night |
| `L` | Aircraft labels |
| `Esc` | Back to the title |

The selector in the top-left panel switches between three recorded 40-minute
samples: a busy Saturday midday with trainers in the circuit, a weekday
late-afternoon peak, and a weekday evening after dark.

## How it works

It is a static site: no build step and no server.

- `index.html`, `game.js`, `game.css` — the game: hoops, scoring, effects, and
  sound (all synthesised with WebAudio, plus the browser's speech synthesis
  for the tower voice; there are no audio files).
- `sky.js`, `sky.css` — the 3D replay engine (three.js): smooths the raw
  ~10-second position reports into continuous flight paths, picks a 3D model
  per aircraft class, and draws the trails, map and sky.
- `data/` — the recorded samples. `windows.json` lists them; each
  `window_<start>_<end>.json` holds every aircraft track in that period.

To run it locally, serve the folder with any static web server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Credits

- Aircraft positions: [adsb.fi](https://adsb.fi) open data.
- Ground imagery: Esri World Imagery (© Esri, Maxar, Earthstar Geographics).
- 3D rendering: [three.js](https://threejs.org), loaded from jsDelivr.

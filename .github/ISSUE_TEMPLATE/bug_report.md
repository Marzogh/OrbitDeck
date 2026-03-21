---
name: Bug report
about: Create a report to help us fix a defect
title: "Bug report - *Add short descriptor here*"
labels: possible bug
assignees: Marzogh

---

##### Any bug report raised here should be submitted according to this template or it may be flagged with `Needs more information`. No action will be taken until the required information is provided.

## Pre-bug report checklist

Do this checklist before filing a bug report:
- [ ] Is this something you can debug and fix? Send a pull request. Bug fixes and documentation fixes are welcome.
- [ ] Is this actually a feature idea or workflow improvement? File it as a feature request instead.
- [ ] Have you checked whether this issue already exists?
- [ ] Have you collected the logs, screenshots, or exact reproduction steps needed to show the problem?

<hr>

## Bug report

#### Describe the bug

_Include a clear and concise description of what the bug is._

#### Affected OrbitDeck surface

- [ ] Rotator / live pass
- [ ] Radio control
- [ ] APRS ops
- [ ] Settings
- [ ] Lite UI
- [ ] Backend / API
- [ ] Docs / packaging / release

#### To reproduce

Provide exact steps to reproduce the problem.

1. Go to `...`
2. Click `...`
3. Change `...`
4. Observe `...`

#### Expected behavior

A clear and concise description of what you expected to happen.

#### Actual behavior

A clear and concise description of what actually happened.

#### Screenshots or recordings

If applicable, add screenshots or a short recording to help explain the problem.

#### Logs / console output / API errors

Include the relevant sections only. Wrap logs in code blocks.

```text
PASTE LOGS HERE
```

#### Environment

- OrbitDeck version / tag: [e.g. `v0.1.0-alpha-macos.1`]
- Commit (if running from source): [e.g. `b6fca6e`]
- OS: [e.g. macOS 15.x]
- Browser: [e.g. Zen / Firefox / Safari / Chrome]
- Radio model: [e.g. IC-705 / ID-5100 / none]
- Radio transport mode: [e.g. USB / Wi-Fi / none]
- APRS mode: [e.g. satellite / terrestrial / not applicable]
- Reproduced during: [e.g. fake pass / real pass / no pass required]

#### Additional context

Add any other context that will help diagnose the issue.

<hr>

###### DO NOT DELETE OR EDIT anything below this

<hr>

<sub><b>Note 1:</b> Make sure to add all the information needed to understand the bug so someone can help. If essential information is missing, the issue may be marked <code>Needs more information</code>.</sub>

<sub><b>Note 2:</b> Reports about kiosk/operator behavior should state whether the issue was seen during a real pass or only under fake-pass/developer mode.</sub>

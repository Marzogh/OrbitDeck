# TX Authorization

OrbitDeck protects RF transmission without placing the tracking and receive interfaces behind a general login wall.

## What remains open

The following operations do not require authentication:

- tracking satellites and viewing passes
- receiving and reviewing APRS packets
- connecting a receive-only APRS session
- connecting, polling, tuning, and applying Doppler correction to a radio
- stopping radio automation
- disconnecting radio or APRS sessions
- APRS emergency stop

Changing a frequency or preparing an uplink does not key the transmitter, so those controls remain available while TX is locked.

## What requires authorization

OrbitDeck requires TX authorization before:

- sending APRS messages, status packets, or position packets
- enabling terrestrial APRS digipeating
- connecting APRS while terrestrial digipeating is enabled

These checks are enforced by the server. Hiding or disabling a browser button is not treated as the security boundary.

## First-time setup

1. Start OrbitDeck normally.
2. Select the `TX Locked` indicator in the lower-right corner, or use an APRS send control.
3. Create and confirm a TX PIN of at least four characters.
4. OrbitDeck changes the indicator to `TX Unlocked` and continues the requested transmit action.

The PIN may contain any characters; there are no digit-only or complexity rules. OrbitDeck stores it as a salted PBKDF2 hash and does not store the original PIN.

The PIN is reusable, but TX authorization is exclusive: only one browser session can hold it at a time. The active session must select `Lock TX` before another browser can unlock. There is deliberately no inactivity or disconnected-session timeout, so closing a tab, losing Wi-Fi, or putting a phone to sleep cannot release or steal authorization during a QSO. If the original browser is unavailable, restarting the OrbitDeck host releases the lease.

## Authorization lifetime

TX authorization is tied to the host system boot rather than to an inactivity timer.

It remains valid through:

- long QSOs
- page reloads
- browser restarts
- temporary LAN or Wi-Fi interruption
- OrbitDeck process or service restarts

It becomes invalid after:

- the host Mac or Raspberry Pi reboots
- an authorized operator selects `TX Unlocked` and confirms `Lock TX`
- the TX credential is replaced

Locking TX releases the exclusive session and revokes its browser cookie. The same PIN can then unlock TX in another browser. If terrestrial digipeating is active, OrbitDeck disconnects that APRS session as part of locking.

## Safety behaviour

Actions that reduce or stop transmission never require authentication. An operator can always disconnect APRS or use emergency stop while TX is locked. Wi-Fi APRS also deasserts PTT in a `finally` path after every transmission.

The browser cookie is HTTP-only and same-site. Its signature is checked against both the saved credential generation and the current host boot identifier, so a cookie copied from an earlier boot cannot unlock TX.

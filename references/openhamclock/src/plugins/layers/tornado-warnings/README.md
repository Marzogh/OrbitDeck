# Tornado Warnings Layer

Displays active NWS tornado watches, warnings, and emergencies on the map.

## Data Source

- **API:** [NWS Weather Alerts](https://api.weather.gov/alerts/active)
- **Cost:** Free, no API key required
- **Coverage:** United States only (NWS jurisdiction)
- **Update interval:** Every 2 minutes (3 min in low memory mode)

## Alert Types

| Type                        | Color    | Shape  | Priority |
| --------------------------- | -------- | ------ | -------- |
| Tornado Emergency           | Dark Red | Circle | Highest  |
| Tornado Warning             | Red      | Circle | High     |
| Tornado Watch               | Amber    | Square | Medium   |
| Severe Thunderstorm Warning | Orange   | Circle | Lower    |

## Display

- **Polygons** show the actual affected area, color-coded by severity
- **Watch polygons** use dashed borders to distinguish from warnings
- **Centroid markers** with icons for quick visual identification
- **Popups** show headline, affected areas, expiry countdown, severity, and full NWS description

## Ham Radio Use Case

SKYWARN, ARES/RACES, and emergency communications operators can see active warnings
overlaid on their map while running nets or monitoring SKYWARN frequencies.

# Support

ct-analytics is provided **as is and unsupported**.

It is reference code, published so it can be read, copied and adapted. There is
no support channel, no service-level commitment, and no guarantee that issues
or pull requests will be answered.

## If something does not work

The repository is meant to be self-diagnosing before it is self-supporting:

- **Install health** in the admin lists every event the collector refused,
  with the reason. Most "the reports are empty" questions are answered there.
- The troubleshooting section of [docs/gcp-setup.md](docs/gcp-setup.md) covers
  the failures that come up repeatedly — unregistered site slugs, origin
  mismatches, missing result counts, and Cloud SQL connection strings.
- `npm test` runs the whole suite offline against a scratch database. If it
  passes and your deployment misbehaves, the difference is configuration.

## Using this in production

You are welcome to. Read [docs/privacy.md](docs/privacy.md) first, set
per-site origins, and turn on retention — those three are the decisions the
module deliberately leaves to you.

Treat the code as your own from the moment you deploy it. Nobody else is
watching it for you.

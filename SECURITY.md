# Security policy

## Reporting

Please use [GitHub private vulnerability reporting](https://github.com/ZipLyne-Agency/orca-t3-bridge/security/advisories/new)
for security issues. Include affected versions, reproduction steps using a fake
workspace, expected behavior and impact. Keep credentials and private transcripts
out of the report. Do not publish an exploit against another person's environment.

The latest release is the supported line. Compatibility with future T3 and Orca
versions must be verified before updating the compatibility table.

## Trust and data

This bridge has access to local Orca sessions and can forward your explicit
instructions into agents with their existing permissions. Use it only on a trusted
Mac and protect access to your T3 environment. A workspace filter limits discovery;
it is not a sandbox for an agent.

Orca and T3 credentials are used in memory for local protocol calls. T3 stores
imported conversation text. Local bridge state stores identifiers, receipt hashes,
leases and sync revisions. Do not publish that state or app runtime metadata.

The bridge adds no public listener. Remote authentication, transport and phone
pairing remain T3's responsibility. The adapter uses scoped, expiring T3 sessions
and revokes its own sessions when closing normally.

Unknown delivery outcomes require reconciliation. No automatic resend or native
approval is performed. These controls do not guarantee global exactly-once
delivery, provider spending limits or isolation from an already compromised host.
See [architecture and limits](docs/architecture.md) for the inspected boundaries.

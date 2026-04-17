# Contract adopter kit

For repos that **produce** or **consume** AtlaSent envelopes — the
policy engine, downstream SDKs in other languages, integration test
harnesses. Drop the files in this directory into your repo and you
get machine-enforced conformance to contract v1 with no deep reading
of the schemas required.

## What's here

| File | For |
|------|-----|
| [`validate_response.py`](./validate_response.py) | Single-file CLI. Validates a JSON body against one of the contract schemas. Exit 0 on pass, 1 on schema violation, 2 on usage error. |
| [`validate-against-atlasent-contract.yml`](./validate-against-atlasent-contract.yml) | Drop-in GitHub Actions workflow. Discovers response fixtures by filename and fails PRs that violate the contract. |
| [`EXPECTED_ENVELOPES.md`](./EXPECTED_ENVELOPES.md) | Plain-English reference of the required request / response shapes. No schema reading needed for the 90% case. |

## Recommended integration

### Option A — submodule (preferred for upstream-tracking engines)

```bash
git submodule add \
  https://github.com/AtlaSent-Systems-Inc/atlasent-sdk-python \
  third_party/atlasent-sdk-python
git -C third_party/atlasent-sdk-python checkout sdk-suite-v1.0
git add .gitmodules third_party/atlasent-sdk-python
```

Then in your repo's CI, vendor-map `contract/` to a stable path:

```yaml
env:
  CONTRACT_DIR: third_party/atlasent-sdk-python/contract
```

Pros: you pick up contract updates by bumping the submodule's pinned
tag. Always attributable. No copy drift.

### Option B — copy-and-track (simpler, no submodule overhead)

```bash
curl -sL \
  https://github.com/AtlaSent-Systems-Inc/atlasent-sdk-python/archive/refs/tags/sdk-suite-v1.0.tar.gz \
  | tar -xz --strip-components=1 -C third_party/atlasent-contract \
    atlasent-sdk-python-sdk-suite-v1.0/contract
```

Pros: zero submodule ceremony. Cons: you own the upgrade cadence; a
dependabot equivalent is nice-to-have but optional.

### Wire up CI

```bash
mkdir -p .github/workflows
cp third_party/atlasent-contract/adopt/validate-against-atlasent-contract.yml \
   .github/workflows/
```

Edit `CONTRACT_DIR` and `FIXTURES_DIR` at the top of the workflow to
match where you put things. Done.

## What the workflow enforces

For every `*.json` file in `FIXTURES_DIR`:

| Filename prefix | Validated against |
|-----------------|-------------------|
| `evaluate_*.json` | `evaluate-response.schema.json` |
| `verify_*.json`   | `verify-permit-response.schema.json` |
| `error_*.json`    | `error-response.schema.json` |

Files with no matching prefix are skipped (so you can mix contract
fixtures with other JSON files in the same dir).

The workflow fails the PR if any fixture violates the contract,
printing the JSON path of the first violation.

## Using the CLI directly

The workflow shells out to `validate_response.py`. You can run it the
same way from a Makefile, a pre-commit hook, or a local dev script:

```bash
# Validate a file
python contract/adopt/validate_response.py \
  evaluate-response \
  tests/fixtures/evaluate_allow.json

# Validate stdin (great for curl-piping against a live engine)
curl -s "$ENGINE/v1-evaluate" -d @req.json \
  | python contract/adopt/validate_response.py evaluate-response -
```

Exit codes: **0** valid, **1** schema violation, **2** usage error.

## Endpoint name reference

The CLI's first argument is the endpoint name, one of:

- `evaluate-request`
- `evaluate-response`
- `verify-permit-request`
- `verify-permit-response`
- `error-response`
- `policy`

Each corresponds to `contract/schemas/<name>.schema.json`.

## Versioning

Pin your adopter repo to a tag. Contract v1 is stable — breaking wire
changes will go out as a new major version (`contract/v2/` in schema
`$id` URIs) on a separate branch, giving you a clean cutover window.

Current recommended pin: **`sdk-suite-v1.0`**.

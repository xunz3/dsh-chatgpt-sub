# Releasing

Pushes to `main` run the shared checks on Node 22, 24, and 26. Publication starts only after all checks pass and uses the exact tarball verified by the Node 26 job.

- An unpublished version in `package.json` is published automatically: stable versions to `latest`, prereleases to `next`.
- An already published version is skipped. Documentation-only pushes do not require a version bump.
- Registry errors stop publication. An older stable version cannot move `latest` backwards.
- Publication verifies the registry version, dist-tag, and tarball integrity. A manual run on `main` defaults to dry-run.

## One-time npm setup

After the first local publication, configure npm Trusted Publishing for GitHub repository `xunz3/dsh-chatgpt-sub`, workflow filename `publish.yml`, with direct publishing allowed and no environment name. No `NPM_TOKEN` secret is needed.

An authorized npm account can configure this with npm 11.15+ (browser/2FA authorization may be required):

```sh
npm trust github --file publish.yml --repo xunz3/dsh-chatgpt-sub --allow-publish
npm trust list
```

See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/). Push access to `main` authorizes release changes; protect that branch according to your repository's maintainer policy.

## Publish a version

Update `package.json` to the intended version, or use `npm version patch --no-git-tag-version`. Commit the change and push to `main`. No GitHub Release or version tag is required to trigger publication.

If publication fails, fix the reported cause and rerun the workflow after checking the registry. Do not delete or replace an existing npm version.

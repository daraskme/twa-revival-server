# Security and publication boundaries

This repository contains source code and synthetic examples for review. It does not contain operational credentials or a production deployment configuration.

Never commit EOS client secrets, release-signing private keys, Cloudflare tokens, administrator tokens, relay signing secrets, player session tokens, private account settings, real databases or diagnostic archives. Environment-variable names in the source describe the interface to the private deployment; they are not credentials.

The public repository starts from a new history. Do not merge or push the internal repository's history, tags or branches into it. `.gitignore` helps prevent accidental additions but does not inspect file contents or remove already tracked files. Review every staged file and its history before publishing changes.

Report a suspected secret exposure through GitHub's private security reporting when available. Do not paste the secret into a public issue. For other account-related support, state only that you need account support at https://darask.me/twa/support/ and wait for the operator's instructions.

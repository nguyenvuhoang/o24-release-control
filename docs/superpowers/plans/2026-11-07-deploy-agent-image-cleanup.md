# Deploy Agent image cleanup plan

1. Add opt-in cleanup settings to the agent config, with a 24-hour default minimum age.
2. Add unit tests for disabled cleanup, configured/default age, success output, and best-effort failure.
3. Run `docker image prune -a -f --filter until=<hours>h` only after health and digest verification succeed.
4. Document the settings, update the example config, and bump the agent patch version.
5. Run formatting and the complete Deploy Agent test suite.

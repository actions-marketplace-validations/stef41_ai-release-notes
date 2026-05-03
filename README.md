# 📝 AI Release Notes

**Generates polished, user-facing release notes from your git history using AI.**

> **Gap filled:** Existing changelog generators (auto-changelog, release-drafter) just template commit messages. None use AI to _synthesize_ changes into readable, categorized release notes written for your audience.

## Features

- Supports OpenAI and Anthropic APIs
- Audience targeting: developers, end-users, or both
- Auto-detects version range from tags
- Includes PR details and labels
- Categorizes: breaking changes, features, fixes, improvements, dependencies
- Synthesizes related commits (doesn't just list them)

## Usage

```yaml
- uses: your-org/ai-release-notes@v1
  with:
    ai-provider: 'openai'
    api-key: ${{ secrets.OPENAI_API_KEY }}
    model: 'gpt-4o-mini'
    audience: 'both'
    include-pr-links: 'true'

- name: Create GitHub Release
  uses: softprops/action-gh-release@v2
  with:
    body_path: RELEASE_NOTES.md
```

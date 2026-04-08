# Contributing to Antares

## Getting Started

1. Fork the repository
2. Clone your fork
3. Install dependencies: npm install
4. Create a branch: git checkout -b feature/your-feature

## Development

- npm run dev - Start Plasmo dev server
- npm test - Run tests
- npm run lint - Lint code

## Pull Requests

- Keep PRs focused on a single change
- Write descriptive commit messages (conventional commits preferred)
- Add tests for new detection logic
- Ensure npm test passes before submitting

## Scoring Engine

Changes to pipeline.ts, layers.ts, or scoring.ts require:
- Regression tests with real token examples
- Documentation of threshold changes in commit messages

## Code Style

- TypeScript strict mode
- Prettier configured (.prettierrc.mjs)
- No any types without justification

## Reporting Issues

- Use GitHub Issues for bugs and feature requests
- For security vulnerabilities, see SECURITY.md

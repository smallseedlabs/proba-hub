# Contributing to proba-hub

Thank you for your interest in contributing to proba-hub!

## Code of Conduct

Be respectful, constructive, and professional.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/proba-hub.git`
3. Create a feature branch: `git checkout -b feature/my-feature`
4. Make your changes
5. Commit with conventional commits (see below)
6. Push and open a pull request

## Development Setup

```bash
npm install
docker compose up -d postgres redis
npm run migrate
npm run seed
npm run dev
```

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style (formatting, no logic change)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Build process, dependencies, etc.

Examples:
```
feat: add support for batch commands
fix: resolve SSE reconnection race condition
docs: update API examples in README
```

## Code Style

- Run `npm run lint` before committing
- Follow TypeScript best practices
- Use meaningful variable names
- Add comments for complex logic
- Keep functions focused and small

## Testing

- Write unit tests for new features
- Add integration tests for critical paths
- Ensure all tests pass: `npm test && npm run test:integration`
- Maintain or improve code coverage

## Pull Request Process

1. Update documentation if needed
2. Add tests for your changes
3. Ensure CI passes
4. Update CHANGELOG.md
5. Request review from maintainers
6. Address review feedback

## Architecture Guidelines

### Database Changes

- Always create a new migration file
- Never modify existing migrations
- Use transactions for DDL changes
- Test migrations both up and rollback

### API Changes

- Maintain backward compatibility when possible
- Follow the protocol contract
- Update OpenAPI/schema definitions
- Document breaking changes clearly

### Event Processing

- Keep command processing idempotent
- Ensure events are sequential per user
- Handle brain errors gracefully
- Log at appropriate levels

### Multi-Instance Considerations

- Don't rely on in-memory state
- Use Redis for cross-instance coordination
- Test outbox relay behavior
- Verify SSE fan-out works

## Reporting Issues

- Check existing issues first
- Use issue templates
- Provide reproduction steps
- Include environment details
- Attach relevant logs

## Questions?

Open a discussion or issue on GitHub.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.

import { describe, it, expect } from 'vitest';
import { nextExecutionState } from './execution-state.js';

describe('nextExecutionState', () => {
  it('pause pauses a running workspace', () => {
    expect(nextExecutionState('running', 'pause')).toBe('paused');
    expect(nextExecutionState('paused', 'pause')).toBe('paused');
  });

  it('kill stops from any state', () => {
    expect(nextExecutionState('running', 'kill')).toBe('stopped');
    expect(nextExecutionState('paused', 'kill')).toBe('stopped');
    expect(nextExecutionState('stopped', 'kill')).toBe('stopped');
  });

  it('a pause never lifts an emergency stop', () => {
    expect(nextExecutionState('stopped', 'pause')).toBe('stopped');
  });

  it('resume runs again from paused and from stopped', () => {
    expect(nextExecutionState('paused', 'resume')).toBe('running');
    expect(nextExecutionState('stopped', 'resume')).toBe('running');
    expect(nextExecutionState('running', 'resume')).toBe('running');
  });
});

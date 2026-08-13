import { EVENT_RUN_CREATED, EVENT_TASK_INSTALLED, EventBus } from '@at/core';
import { describe, expect, it } from 'vitest';

describe('event bus', () => {
    it('delivers events to subscribers', () => {
        const bus = new EventBus();
        const received: string[] = [];
        const off = bus.On(EVENT_RUN_CREATED, (event) => {
            received.push(event.Payload.runId as string);
        });
        bus.Emit(EVENT_RUN_CREATED, { runId: 'run-1' });
        expect(received).toEqual(['run-1']);
        off();
        bus.Emit(EVENT_RUN_CREATED, { runId: 'run-2' });
        expect(received).toEqual(['run-1']);
    });

    it('does not deliver unrelated events', () => {
        const bus = new EventBus();
        let count = 0;
        bus.On(EVENT_TASK_INSTALLED, () => {
            count++;
        });
        bus.Emit(EVENT_RUN_CREATED, {});
        expect(count).toBe(0);
    });
});

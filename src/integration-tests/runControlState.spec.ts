/*********************************************************************
 * Copyright (c) 2026 Arm Limited and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/

import { expect } from 'chai';
import * as sinon from 'sinon';
import { GDBDebugSessionBase } from '../gdb/GDBDebugSessionBase';
import { ThreadWithStatus } from '../gdb/common';
import { GDBThreadRunning } from '../gdb/errors';
import { IGDBBackendFactory } from '../types/gdb';
import { RequestArgRun } from '../types/session';

class TestSession extends GDBDebugSessionBase {
    constructor() {
        super({} as IGDBBackendFactory);
    }
}

describe('run-control state across main integration', function () {
    let sandbox: sinon.SinonSandbox;
    let session: any;
    let backend: any;

    beforeEach(function () {
        sandbox = sinon.createSandbox();
        backend = {
            isNonStopMode: sandbox.stub().returns(false),
            getAsyncMode: sandbox.stub().returns(true),
            sendCommand: sandbox.stub().resolves({}),
        };
        session = new TestSession();
        session.gdb = backend;
        session.threads = [new ThreadWithStatus(1, 'main', false)];
        sandbox.stub(session, 'canRequestProceed').returns(true);
        sandbox.stub(session, 'sendResponse');
        sandbox.stub(session, 'sendErrorResponse');
        sandbox.stub(session, 'sendEvent');
        sandbox.stub(session, 'handleGDBStopped');
    });

    afterEach(function () {
        sandbox.restore();
    });

    it('returns MI results for console requests without a frame', async function () {
        backend.sendCommand.resolves({ value: '42' });
        const response: any = {};

        await session.evaluateRequest(response, {
            context: 'repl',
            expression: '>-data-evaluate-expression 6*7',
        });

        expect(
            backend.sendCommand.calledOnceWith('-data-evaluate-expression 6*7')
        ).to.be.true;
        expect(response.body.result).to.equal('{"value":"42"}');
        expect(session.sendErrorResponse.called).to.be.false;
    });

    it('marks a thread running before sending a resume and preserves its MI result', async function () {
        const result = { running: true };
        backend.sendCommand.callsFake(async () => {
            expect(session.threads[0].running).to.be.true;
            return result;
        });

        expect(
            await session.sendCommandToGdb(backend, '-exec-continue', undefined)
        ).to.equal(result);
        expect(session.isRunning).to.be.true;
    });

    it('waits for the selected thread to stop before sending a framed command', async function () {
        backend.isNonStopMode.returns(true);
        session.threads[0].running = true;
        session.isRunning = true;
        const command = session.sendCommandToGdb(
            backend,
            '-data-evaluate-expression $pc',
            { threadId: 1, frameId: 0 }
        );
        expect(backend.sendCommand.called).to.be.false;

        session.handleGDBAsync('stopped', {
            'thread-id': '1',
            'stopped-threads': 'all',
            reason: 'breakpoint-hit',
        });
        await command;

        expect(backend.sendCommand.calledOnce).to.be.true;
        expect(session.stoppedStateRequests).to.have.length(0);
    });

    it('rejects a framed command if the target does not stop within the wait', async function () {
        const clock = sandbox.useFakeTimers();
        session.threads[0].running = true;
        session.isRunning = true;
        const outcome = session
            .sendCommandToGdb(backend, '-data-evaluate-expression $pc', {
                threadId: 1,
                frameId: 0,
            })
            .catch((error: unknown) => error);

        await clock.tickAsync(500);

        expect(await outcome).to.be.instanceOf(GDBThreadRunning);
        expect(backend.sendCommand.called).to.be.false;
        expect(session.stoppedStateRequests).to.have.length(0);
    });

    it('preserves the last known state until a new thread reports its state', async function () {
        backend.isNonStopMode.returns(true);
        session.threads[0].running = true;
        session.isRunning = true;
        session.handleGDBNotify('thread-created', { id: '2' });
        expect(session.isRunning).to.be.true;

        const stopped = session.waitForStoppedState(2);
        expect(session.stoppedStateRequests).to.have.length(1);
        session.handleGDBAsync('stopped', {
            'thread-id': '2',
            reason: 'breakpoint-hit',
        });

        expect(await stopped).to.be.true;
        expect(
            session.threads.map((thread: ThreadWithStatus) => thread.running)
        ).to.deep.equal([true, false]);
    });

    it('suppresses a running-target error for a REPL expression', async function () {
        const clock = sandbox.useFakeTimers();
        session.threads[0].running = true;
        session.isRunning = true;
        const frameId = session.frameHandles.create({
            threadId: 1,
            frameId: 0,
        });
        const request = session.evaluateRequest(
            {},
            {
                context: 'repl',
                expression: '$pc',
                frameId,
            }
        );

        await clock.tickAsync(500);
        await request;

        expect(session.sendErrorResponse.called).to.be.false;
        expect(session.sendResponse.calledOnce).to.be.true;
        expect(backend.sendCommand.called).to.be.false;
    });

    it('reports other REPL errors without requesting a notification', async function () {
        backend.sendCommand.rejects(new Error('Unknown command'));
        await session.evaluateRequest(
            {},
            {
                context: 'repl',
                expression: '>invalid-command',
            }
        );

        expect(session.sendErrorResponse.calledOnce).to.be.true;
        expect(session.sendErrorResponse.firstCall.args[1]).to.deep.equal({
            id: 1,
            format: 'Unknown command',
            showUser: false,
        });
    });

    it('keeps a preserved launch stopped and uses run on the first continue', async function () {
        session.runAfterConfiguration = RequestArgRun.PRESERVE;
        session.sendInitializedEvent();
        await session.configurationDoneRequest({}, {});
        expect(backend.sendCommand.called).to.be.false;

        backend.sendCommand.callsFake(async (command: string) => {
            expect(command).to.equal('-exec-run');
            expect(session.isRunning).to.be.true;
            return {};
        });
        await session.continueRequest({}, { threadId: 1 });

        expect(backend.sendCommand.calledOnce).to.be.true;
        expect(session.sendErrorResponse.called).to.be.false;
    });

    it('keeps an attached stopped target stopped with run=preserve', async function () {
        session.isAttach = true;
        session.runAfterConfiguration = RequestArgRun.PRESERVE;
        session.sendInitializedEvent();
        await session.configurationDoneRequest({}, {});

        expect(backend.sendCommand.called).to.be.false;
        expect(session.firstContinueIsRun).to.be.false;
        expect(session.isRunning).to.be.false;
    });

    it('defers stop events until configuration is complete and resumes with the new state guard', async function () {
        session.sendInitializedEvent();
        session.handleGDBAsync('running', { 'thread-id': 'all' });
        session.handleGDBAsync('stopped', {
            'thread-id': '1',
            reason: 'breakpoint-hit',
        });
        expect(session.handleGDBStopped.called).to.be.false;
        expect(session.deferredStopEvents).to.have.length(1);

        backend.sendCommand.callsFake(async (command: string) => {
            expect(command).to.equal('-exec-run');
            expect(session.isRunning).to.be.true;
            session.handleGDBAsync('running', { 'thread-id': 'all' });
            return {};
        });
        await session.configurationDoneRequest({}, {});

        expect(session.handleGDBStopped.called).to.be.false;
        expect(session.deferredStopEvents).to.have.length(0);
        expect(session.sendErrorResponse.called).to.be.false;
    });
});

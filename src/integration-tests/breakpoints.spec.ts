/*********************************************************************
 * Copyright (c) 2019 Arm and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/

import * as path from 'path';
import { expect } from 'chai';
import { CdtDebugClient } from './debugClient';
import {
    standardBeforeEach,
    testProgramsDir,
    getScopes,
    verifyVariable,
    gdbVersionAtLeast,
    Scope,
    fillDefaults,
    gdbAsync,
    isRemoteTest,
    hardwareBreakpoint,
    gdbNonStop,
} from './utils';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as os from 'os';

describe('breakpoints', async function () {
    let dc: CdtDebugClient;

    beforeEach(async function () {
        dc = await standardBeforeEach();
        await dc.launchRequest(
            fillDefaults(this.currentTest, {
                program: path.join(testProgramsDir, 'count'),
            })
        );
    });

    afterEach(async () => {
        await dc.stop();
    });

    it('should handle a breakpoint created from the debug-console/terminal', async function () {
        if (os.platform() === 'win32' || !(isRemoteTest && gdbAsync)) {
            this.skip();
        }
        const scope: Scope = await getScopes(dc);
        /* 
            Create an event variable that will eventually wait for the custom event being sent when a breakpoint is created
            Just using 
            await dc.waitForEvent('breakpoint'); 
            is NOT enough, as it misses the event from the adapter due to misalignment issues
        */
        const event = dc.waitForEvent('breakpoint');
        // Trigger a breakpoint from the debug-console/Terminal
        await dc.evaluateRequest({
            expression: `>break ${testProgramsDir}/count.c:4`,
            frameId: scope.frame.id,
            context: 'repl',
        });
        const outputs = await event;
        // Run a configuration Done Request to inform the adapter that the client is done
        await dc.configurationDoneRequest();

        expect(outputs.body.reason).eq('new');
        expect(outputs.body.breakpoint.line).eq(4);
    });

    it('should handle a breakpoint modification from the debug-console/terminal', async function () {
        if (os.platform() === 'win32' || !(isRemoteTest && gdbAsync)) {
            this.skip();
        }
        let event;
        const scope: Scope = await getScopes(dc);
        /* 
            Create an event variable that will eventually wait for the custom event being sent when a breakpoint is created
            Just using 
            await dc.waitForEvent('breakpoint'); 
            is NOT enough, as it misses the event from the adapter due to misalignment issues
        */
        event = dc.waitForEvent('breakpoint');
        // Create a breakpoint from the debug-console/Terminal
        await dc.evaluateRequest({
            expression: `>break ${testProgramsDir}/count.c:4`,
            frameId: scope.frame.id,
            context: 'repl',
        });
        // Wait to make sure breakpoint is created
        await event;

        event = dc.waitForEvent('breakpoint');
        // Modify the breakpoint from the debug-console/terminal
        await dc.evaluateRequest({
            expression: `>disable 1`,
            frameId: scope.frame.id,
            context: 'repl',
        });
        const outputs = await event;
        // Run a configuration Done Request to inform the adapter that the client is done
        await dc.configurationDoneRequest();

        expect(outputs.body.reason).eq('changed');
    });

    it('should handle a breakpoint deletion from the debug-console/terminal', async function () {
        if (os.platform() === 'win32' || !(isRemoteTest && gdbAsync)) {
            this.skip();
        }
        let event;
        const scope: Scope = await getScopes(dc);
        /* 
            Create an event variable that will eventually wait for the custom event being sent when a breakpoint is created
            Just using 
            await dc.waitForEvent('breakpoint'); 
            is NOT enough, as it misses the event from the adapter due to misalignment issues
        */
        event = dc.waitForEvent('breakpoint');
        // Create a breakpoint from the debug-console/Terminal
        await dc.evaluateRequest({
            expression: `>break ${testProgramsDir}/count.c:4`,
            frameId: scope.frame.id,
            context: 'repl',
        });
        // Wait to make sure breakpoint is created
        await event;

        event = dc.waitForEvent('breakpoint');
        // Modify the breakpoint from the debug-console/terminal
        await dc.evaluateRequest({
            expression: `>delete 1`,
            frameId: scope.frame.id,
            context: 'repl',
        });
        const outputs = await event;
        // Run a configuration Done Request to inform the adapter that the client is done
        await dc.configurationDoneRequest();

        expect(outputs.body.reason).eq('removed');
    });

    it('set breakpoints from terminal without GUI reflection will auto erase the bp', async function () {
        if (os.platform() === 'win32' || !(isRemoteTest && gdbAsync)) {
            // win32 host can only pause remote + mi-async targets
            this.skip();
        }
        const scope = await getScopes(dc);

        // Setting a breakpoint from the debug-console/terminal without reflecting on GUI,
        // it should be erased when setBreakpointsRequest is called
        const event = dc.waitForEvent('breakpoint');
        await dc.evaluateRequest({
            expression: `>break ${testProgramsDir}/count.c:4`,
            frameId: scope.frame.id,
            context: 'repl',
        });
        await event;
        const waitEvent = dc.waitForEvent('stopped');
        await dc.configurationDoneRequest();
        await waitEvent;

        // start listening for stopped events before we issue the
        // setBreakpointsRequest to ensure we don't get extra
        // stopped events
        const stoppedEventWaitor = dc.waitForEvent('stopped');

        const response = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 6,
                },
            ],
        });
        await dc.continueRequest({ threadId: scope.thread.id });
        // Should have only 1 breakpoint at line 6, not 2
        expect(response.body.breakpoints.length).to.eq(1);
        await dc.assertStoppedLocation('breakpoint', { line: 6 });
        const stoppedEvent = await stoppedEventWaitor;
        expect(stoppedEvent).to.have.property('body');
        expect(stoppedEvent.body).to.have.property('reason', 'breakpoint');
    });

    it('can set breakpoints from terminal and GUI together', async function () {
        if (os.platform() === 'win32' || !(isRemoteTest && gdbAsync)) {
            // win32 host can only pause remote + mi-async targets
            this.skip();
        }

        const scope = await getScopes(dc);

        // Setting a breakpoint from the debug-console/terminal
        const event = dc.waitForEvent('breakpoint');
        await dc.evaluateRequest({
            expression: `>break ${testProgramsDir}/count.c:4`,
            frameId: scope.frame.id,
            context: 'repl',
        });
        await event;
        const waitEvent = dc.waitForEvent('stopped');
        await dc.configurationDoneRequest();
        await waitEvent;

        // start listening for stopped events before we issue the
        // setBreakpointsRequest to ensure we don't get extra
        // stopped events
        const stoppedEventWaitor = dc.waitForEvent('stopped');
        // Setting a breakpoint from the GUI also at line 4.
        // setBreakpointsRequest should resolve the bps and resolve to a single bp at line 4
        const response = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                },
            ],
        });
        await dc.continueRequest({ threadId: scope.thread.id });
        // Should have only 1 breakpoint at line 4
        expect(response.body.breakpoints.length).to.eq(1);
        await dc.assertStoppedLocation('breakpoint', { line: 4 });
        const stoppedEvent = await stoppedEventWaitor;
        expect(stoppedEvent).to.have.property('body');
        expect(stoppedEvent.body).to.have.property('reason', 'breakpoint');
    });

    it('set an instruction breakpoint', async function () {
        if (gdbNonStop && isRemoteTest) {
            this.skip();
        }
        const bpResp = await dc.setInstructionBreakpointsRequest({
            breakpoints: [
                {
                    instructionReference: '0x720',
                },
            ],
        });
        expect(bpResp.body.breakpoints.length).eq(1);
        expect(bpResp.body.breakpoints[0].instructionReference).eq('0x720');
    });

    it('set type of standard breakpoint', async () => {
        const bpResp = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                },
            ],
        });
        expect(bpResp.body.breakpoints.length).eq(1);
        expect(bpResp.body.breakpoints[0].verified).eq(true);
        expect(bpResp.body.breakpoints[0].message).eq(undefined);
        await dc.configurationDoneRequest();
        let isCorrect;
        let outputs;
        while (!isCorrect) {
            // Cover the case of getting event in Linux environment.
            // If cannot get correct event, program timeout and test case failed.
            outputs = await dc.waitForEvent('output');
            isCorrect = outputs.body.output.includes('breakpoint-modified');
        }
        let substring: string;
        if (hardwareBreakpoint) {
            substring = 'type="hw breakpoint"';
        } else {
            substring = 'type="breakpoint"';
        }
        expect(outputs?.body.output).includes(substring);
    });

    it('hits a standard breakpoint', async () => {
        const bpResp = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                },
            ],
        });
        expect(bpResp.body.breakpoints.length).eq(1);
        expect(bpResp.body.breakpoints[0].verified).eq(true);
        expect(bpResp.body.breakpoints[0].message).eq(undefined);
        await dc.configurationDoneRequest();
        await dc.waitForEvent('stopped');
        const scope = await getScopes(dc);
        const vr = scope.scopes.body.scopes[0].variablesReference;
        const vars = await dc.variablesRequest({ variablesReference: vr });
        verifyVariable(vars.body.variables[0], 'count', 'int', '0');
    });

    it('can set breakpoints while program is running', async function () {
        if (os.platform() === 'win32' && (!isRemoteTest || !gdbAsync)) {
            // win32 host can only pause remote + mi-async targets
            this.skip();
        }
        let response = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 2,
                },
            ],
        });
        expect(response.body.breakpoints.length).to.eq(1);
        await dc.configurationDoneRequest();
        await dc.waitForEvent('stopped');
        const scope = await getScopes(dc);
        await dc.continueRequest({ threadId: scope.thread.id });

        // start listening for stopped events before we issue the
        // setBreakpointsRequest to ensure we don't get extra
        // stopped events
        const stoppedEventWaitor = dc.waitForEvent('stopped');

        response = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                },
            ],
        });
        expect(response.body.breakpoints.length).to.eq(1);
        await dc.assertStoppedLocation('breakpoint', { line: 4 });
        const stoppedEvent = await stoppedEventWaitor;
        expect(stoppedEvent).to.have.property('body');
        expect(stoppedEvent.body).to.have.property('reason', 'breakpoint');
    });

    it('handles breakpoints in multiple files', async () => {
        await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                },
            ],
        });
        await dc.setBreakpointsRequest({
            source: {
                name: 'count_other.c',
                path: path.join(testProgramsDir, 'count_other.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 2,
                },
            ],
        });
        await dc.configurationDoneRequest();
        await dc.waitForEvent('stopped');
        const scope = await getScopes(dc);
        const vr = scope.scopes.body.scopes[0].variablesReference;
        const vars = await dc.variablesRequest({ variablesReference: vr });
        verifyVariable(vars.body.variables[0], 'count', 'int', '0');
    });

    it('fails gracefully on breakpoint on unknown file', async () => {
        const bpResp = await dc.setBreakpointsRequest({
            source: {
                name: 'countBAD.c',
                path: path.join(testProgramsDir, 'countBAD.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                },
            ],
        });
        expect(bpResp.body.breakpoints.length).to.eq(1);
        expect(bpResp.body.breakpoints[0].verified).to.eq(false);
        expect(bpResp.body.breakpoints[0].message).not.eq(undefined);
    });

    it('fails gracefully on breakpoint on bad line in otherwise good source', async () => {
        const bpResp = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4 + 100000000,
                },
            ],
        });
        expect(bpResp.body.breakpoints.length).to.eq(1);
        expect(bpResp.body.breakpoints[0].verified).to.eq(false);
        expect(bpResp.body.breakpoints[0].message).not.eq(undefined);
    });

    it('maintains breakpoint order when modifying breakpoints in a file', async () => {
        const bpResp1 = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 6,
                },
            ],
        });
        expect(bpResp1.body.breakpoints.length).to.eq(1);
        expect(bpResp1.body.breakpoints[0].line).eq(6);
        const bpResp2 = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                },
                {
                    column: 1,
                    line: 6,
                },
            ],
        });
        expect(bpResp2.body.breakpoints.length).to.eq(2);
        expect(bpResp2.body.breakpoints[0].line).eq(4);
        expect(bpResp2.body.breakpoints[1].line).eq(6);
        // Make sure the GDB id of the breakpoint on line 6 is unchanged
        expect(bpResp2.body.breakpoints[1].id).eq(
            bpResp1.body.breakpoints[0].id
        );
    });

    it('maintains breakpoint order when modifying breakpoints in a file with space', async () => {
        const bpResp1 = await dc.setBreakpointsRequest({
            source: {
                name: 'count space.c',
                path: path.join(testProgramsDir, 'count space.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 6,
                },
            ],
        });
        expect(bpResp1.body.breakpoints.length).to.eq(1);
        expect(bpResp1.body.breakpoints[0].line).eq(6);
        const bpResp2 = await dc.setBreakpointsRequest({
            source: {
                name: 'count space.c',
                path: path.join(testProgramsDir, 'count space.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 2,
                },
                {
                    column: 1,
                    line: 6,
                },
            ],
        });
        expect(bpResp2.body.breakpoints.length).to.eq(2);
        expect(bpResp2.body.breakpoints[0].line).eq(2);
        expect(bpResp2.body.breakpoints[1].line).eq(6);
        // Make sure the GDB id of the breakpoint on line 6 is unchanged
        expect(bpResp2.body.breakpoints[1].id).eq(
            bpResp1.body.breakpoints[0].id
        );
    });

    it('reports back relocated line number', async function () {
        if (!(await gdbVersionAtLeast('8.2'))) {
            this.skip();
        }

        const args = {
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 5, // this will be relocated to line 6 as no code on line 5
                },
            ],
        } as DebugProtocol.SetBreakpointsArguments;
        const bpResp = await dc.setBreakpointsRequest(args);
        // Make sure the GDB id of the breakpoint is unchanged
        expect(bpResp.body.breakpoints[0].line).eq(6);
    });

    it('maintains gdb breakpoint when relocated', async function () {
        if (!(await gdbVersionAtLeast('8.2'))) {
            this.skip();
        }

        const args = {
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 5, // this will be relocated to line 6 as no code on line 5
                },
            ],
        } as DebugProtocol.SetBreakpointsArguments;
        const bpResp1 = await dc.setBreakpointsRequest(args);
        expect(bpResp1.body.breakpoints.length).to.eq(1);
        expect(bpResp1.body.breakpoints[0].line).eq(6);
        const bpResp2 = await dc.setBreakpointsRequest(args);
        expect(bpResp2.body.breakpoints.length).to.eq(1);
        expect(bpResp2.body.breakpoints[0].line).eq(6);
        // Make sure the GDB id of the breakpoint is unchanged
        expect(bpResp2.body.breakpoints[0].id).eq(
            bpResp1.body.breakpoints[0].id
        );
    });

    it('maintains gdb breakpoint when relocated - files with spaces', async function () {
        if (!(await gdbVersionAtLeast('8.2'))) {
            this.skip();
        }

        const args = {
            source: {
                name: 'count space.c',
                path: path.join(testProgramsDir, 'count space.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 5, // this will be relocated to line 6 as no code on line 5
                },
            ],
        } as DebugProtocol.SetBreakpointsArguments;
        const bpResp1 = await dc.setBreakpointsRequest(args);
        expect(bpResp1.body.breakpoints.length).to.eq(1);
        expect(bpResp1.body.breakpoints[0].line).eq(6);
        const bpResp2 = await dc.setBreakpointsRequest(args);
        expect(bpResp2.body.breakpoints.length).to.eq(1);
        expect(bpResp2.body.breakpoints[0].line).eq(6);
        // Make sure the GDB id of the breakpoint is unchanged
        expect(bpResp2.body.breakpoints[0].id).eq(
            bpResp1.body.breakpoints[0].id
        );
    });

    it('hits a conditional breakpoint', async () => {
        await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                    condition: 'count == 5',
                },
            ],
        });
        await dc.configurationDoneRequest();
        await dc.waitForEvent('stopped');
        const scope = await getScopes(dc);
        const vr = scope.scopes.body.scopes[0].variablesReference;
        const vars = await dc.variablesRequest({ variablesReference: vr });
        verifyVariable(vars.body.variables[0], 'count', 'int', '5');
    });

    it('hits a hit conditional breakpoint with >', async () => {
        await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                    hitCondition: '> 5',
                },
            ],
        });
        await dc.configurationDoneRequest();
        await dc.waitForEvent('stopped');
        const scope = await getScopes(dc);
        const vr = scope.scopes.body.scopes[0].variablesReference;
        const vars = await dc.variablesRequest({ variablesReference: vr });
        verifyVariable(vars.body.variables[0], 'count', 'int', '5');
    });

    it('hits a hit conditional breakpoint without >', async () => {
        await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 4,
                    hitCondition: '5',
                },
            ],
        });
        await dc.configurationDoneRequest();
        await dc.waitForEvent('stopped');
        const scope = await getScopes(dc);
        const vr = scope.scopes.body.scopes[0].variablesReference;
        const vars = await dc.variablesRequest({ variablesReference: vr });
        verifyVariable(vars.body.variables[0], 'count', 'int', '4');
    });

    it('resolves breakpoints', async () => {
        let response = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 2,
                },
            ],
        });
        expect(response.body.breakpoints.length).to.eq(1);

        await dc.configurationDoneRequest();
        await dc.waitForEvent('stopped');

        response = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 2,
                },
                {
                    column: 1,
                    line: 3,
                },
            ],
        });
        expect(response.body.breakpoints.length).to.eq(2);

        response = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 2,
                    condition: 'count == 5',
                },
                {
                    column: 1,
                    line: 3,
                },
            ],
        });
        expect(response.body.breakpoints.length).to.eq(2);

        response = await dc.setBreakpointsRequest({
            source: {
                name: 'count.c',
                path: path.join(testProgramsDir, 'count.c'),
            },
            breakpoints: [
                {
                    column: 1,
                    line: 2,
                    condition: 'count == 3',
                },
            ],
        });
        expect(response.body.breakpoints.length).to.eq(1);
    });
});

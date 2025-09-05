/*********************************************************************
 * Copyright (c) 2025 Arm and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/

import * as path from 'path';
import { CdtDebugClient } from './debugClient';
import { fillDefaults, gdbAsync, isRemoteTest, resolveLineTagLocations, standardBeforeEach, testProgramsDir } from './utils';
import { TargetLaunchRequestArguments } from '../types/session';

describe('lateAsyncErrorsRemote', async function () {
    let dc: CdtDebugClient;
    const program = path.join(testProgramsDir, 'loopforever');
    const src = path.join(testProgramsDir, 'loopforever.c');
    const lineTags = {
        'main function': 0,
    };

    this.beforeAll(function () {
        resolveLineTagLocations(src, lineTags);
    });

    beforeEach(async function () {
        dc = await standardBeforeEach('debugTargetAdapter.js');
        await dc.launchRequest(
            fillDefaults(this.currentTest, {
                program,
            } as TargetLaunchRequestArguments)
        );
    });

    afterEach(async function () {
        await dc.stop();
    });

    it('should provoke an error and not continue with too many watchpoints, but continue after reducing the number', async function () {
        if (!isRemoteTest || !gdbAsync) {
            this.skip();
        }

        // Set breakpoint at main
        await dc.setBreakpointsRequest({
            source: { path: src },
            breakpoints: [{ line: lineTags['main function'] }],
        });

        await Promise.all([
            dc.waitForEvent('stopped'),
            dc.configurationDoneRequest(),
        ]);

        await dc.assertStoppedLocation('breakpoint', { line: lineTags['main function'], path: src });

    });

});

'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import invariant from 'assert';
import {Emitter} from 'event-kit';
import fs from 'fs';
import nuclideUri from '../../commons-node/nuclideUri';
import * as BuckService from '../../nuclide-buck-rpc';
import ClangFlagsManager from '../lib/ClangFlagsManager';

describe('ClangFlagsManager', () => {

  let flagsManager: ClangFlagsManager;
  let ownerSpy;
  let buildSpy;
  beforeEach(() => {
    flagsManager = new ClangFlagsManager();
    spyOn(BuckService, 'getRootForPath').andReturn(
      nuclideUri.join(__dirname, 'fixtures'),
    );
    ownerSpy = spyOn(BuckService, 'getOwner').andReturn(
      // Default header targets should be ignored
      ['//test:__default_headers__', '//test'],
    );
    spyOn(BuckService, 'getBuildFile').andReturn(
      nuclideUri.join(__dirname, 'fixtures', 'BUCK'),
    );
    buildSpy = spyOn(BuckService, 'build').andReturn(
      {
        success: true,
        results: {
          '//test#compilation-database,iphonesimulator-x86_64': {
            output: 'compile_commands.json',
          },
          // For testing on non-Mac machines.
          '//test#compilation-database,default': {
            output: 'compile_commands.json',
          },
        },
      },
    );
  });

  it('sanitizeCommand()', () => {
    const {sanitizeCommand} = ClangFlagsManager;

    const originalArgs = [
      '/usr/bin/clang',
      '-mios-simulator-version-min=7.0',
      '-c',
      '-x',
      'objective-c',
      '-std=gnu11',
      '-Wno-deprecated',
      '-Wno-conversion',
      '-fobjc-arc',

      '-F',
      'local/path',
      '-F',
      '/absolute/path',
      '-Flocal/path',
      '-F/absolute/path',

      '-I',
      'local/path',
      '-I',
      '/absolute/path',
      '-Ilocal/path',
      '-I/absolute/path',

      '-include',
      'local/path',
      '-include',
      '/absolute/path',

      // This is nonsensical, but should not be transformed.
      '-include/absolute/path',

      '-iquote',
      'local/path',
      '-iquote',
      '/absolute/path',

      '-isysroot',
      'local/path',
      '-isysroot',
      '/absolute/path',

      '-isystem',
      'local/path',
      '-isystem',
      '/absolute/path',

      '-o',
      'buck-out/local/path/EXExample.o',
      'local/path/EXExample.m',
    ];
    const buckProjectRoot = '/Users/whoami/project/';
    const sanitizedCommandArgs = sanitizeCommand(
        '/Users/whoami/project/local/path/EXExample.m', originalArgs, buckProjectRoot);

    const expectedArgs = [
      '/usr/bin/clang',
      '-mios-simulator-version-min=7.0',
      '-c',
      '-x',
      'objective-c',
      '-std=gnu11',
      '-Wno-deprecated',
      '-Wno-conversion',
      '-fobjc-arc',

      '-F',
      buckProjectRoot + 'local/path',
      '-F',
      '/absolute/path',
      '-F' + buckProjectRoot + 'local/path',
      '-F/absolute/path',

      '-I',
      buckProjectRoot + 'local/path',
      '-I',
      '/absolute/path',
      '-I' + buckProjectRoot + 'local/path',
      '-I/absolute/path',

      '-include',
      buckProjectRoot + 'local/path',
      '-include',
      '/absolute/path',

      '-include/absolute/path',

      '-iquote',
      buckProjectRoot + 'local/path',
      '-iquote',
      '/absolute/path',

      '-isysroot',
      buckProjectRoot + 'local/path',
      '-isysroot',
      '/absolute/path',

      '-isystem',
      buckProjectRoot + 'local/path',
      '-isystem',
      '/absolute/path',
    ];
    expect(sanitizedCommandArgs).toEqual(expectedArgs);
  });

  it('gets flags for a source file', () => {
    waitsForPromise(async () => {
      let result = await flagsManager.getFlagsForSrc('test.cpp');
      expect(result).toEqual(['g++', '-fPIC', '-O3']);

      // Make sure this is cached (different file, but same target).
      buildSpy.wasCalled = false;
      result = await flagsManager.getFlagsForSrc('test.h');
      expect(result).toEqual(['g++', '-fPIC', '-O3']);
      expect(BuckService.build).not.toHaveBeenCalled();

      // Make sure cache gets reset.
      flagsManager.reset();
      result = await flagsManager.getFlagsForSrc('test.cpp');
      expect(result).toEqual(['g++', '-fPIC', '-O3']);
      expect(BuckService.build).toHaveBeenCalled();
    });
  });

  it('supports negative caching', () => {
    waitsForPromise(async () => {
      // Unowned projects shouldn't invoke Buck again.
      ownerSpy.andReturn([]);
      let result = await flagsManager.getFlagsForSrc('test');
      expect(result).toBe(null);

      ownerSpy.wasCalled = false;
      result = await flagsManager.getFlagsForSrc('test');
      expect(result).toBe(null);
      expect(BuckService.getOwner).not.toHaveBeenCalled();
    });
  });

  it('gets flags for header files', () => {
    waitsForPromise(async () => {
      let result = await flagsManager.getFlagsForSrc('header.h');
      expect(result).toEqual(['g++', '-fPIC', '-O3']);

      result = await flagsManager.getFlagsForSrc('header.hpp');
      expect(result).toEqual(['g++', '-fPIC', '-O3']);

      // When headers are not properly owned, we should look for source files
      // in the same directory.
      const spy = ownerSpy.andReturn(['//test:__default_headers__']);
      const dir = nuclideUri.join(__dirname, 'fixtures');
      result = await flagsManager.getFlagsForSrc(nuclideUri.join(dir, 'testInternal.h'));
      expect(result).toEqual(['g++', '-fPIC', '-O3']);

      result = await flagsManager.getFlagsForSrc(nuclideUri.join(dir, 'test-inl.h'));
      expect(result).toEqual(['g++', '-fPIC', '-O3']);

      result = await flagsManager.getFlagsForSrc(nuclideUri.join(dir, 'test2.h'));
      expect(result).toBeNull();

      // Make sure we don't try get flags for non-source files.
      result = await flagsManager.getFlagsForSrc(nuclideUri.join(dir, 'compile_commands.h'));
      expect(result).toBeNull();
      expect(spy).not.toHaveBeenCalledWith(nuclideUri.join(dir, 'compile_commands.json'));
    });
  });

  it('gets flags from the compilation database', () => {
    waitsForPromise(async () => {
      let testFile = nuclideUri.join(__dirname, 'fixtures', 'test.cpp');
      let result = await flagsManager.getFlagsForSrc(testFile);
      expect(result).toEqual(['g++', '-fPIC', '-O3']);
      expect(BuckService.build).not.toHaveBeenCalled();

      testFile = nuclideUri.join(__dirname, 'fixtures', 'test.h');
      result = await flagsManager.getFlagsForSrc(testFile);
      expect(result).toEqual(['g++', '-fPIC', '-O3']);

      // Fall back to Buck if it's not in the compilation DB.
      testFile = nuclideUri.join(__dirname, 'fixtures', 'test2.cpp');
      result = await flagsManager.getFlagsForSrc(testFile);
      expect(BuckService.build).toHaveBeenCalled();
      expect(result).toEqual(null);
    });
  });

  it('tracks flag changes', () => {
    waitsForPromise(async () => {
      // Create a mock file watcher.
      const watcher: any = new Emitter();
      watcher.close = jasmine.createSpy('watcher.close');
      let changedCallback = null;
      const watchSpy = spyOn(fs, 'watch').andCallFake((file, _options, cb) => {
        changedCallback = cb;
        return watcher;
      });

      const testFile = nuclideUri.join(__dirname, 'fixtures', 'test.cpp');
      const result = await flagsManager.getFlagsForSrc(testFile);
      invariant(result != null);

      expect(flagsManager.getFlagsChanged(testFile)).toBe(false);
      invariant(changedCallback != null);

      // Ignore changes to other files.
      changedCallback('change', 'otherfile');
      expect(flagsManager.getFlagsChanged(testFile)).toBe(false);

      changedCallback('change', 'compile_commands.json');
      expect(flagsManager.getFlagsChanged(testFile)).toBe(true);

      // Make sure only one file watcher is created.
      const result2 = await flagsManager.getFlagsForSrc(testFile);
      invariant(result2 != null);
      expect(watchSpy.calls.length).toBe(1);

      // File watcher should be destroyed on dispose.
      flagsManager.reset();
      expect(watcher.close).toHaveBeenCalled();
    });
  });

  it('can guess locations of build files', () => {
    waitsForPromise(async () => {
      const file = await ClangFlagsManager._guessBuildFile(
        nuclideUri.join(__dirname, 'fixtures', 'a.cpp'),
      );
      expect(file).toBe(nuclideUri.join(__dirname, 'fixtures', 'compile_commands.json'));
    });
  });

});

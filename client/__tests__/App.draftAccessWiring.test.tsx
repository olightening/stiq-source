/**
 * App.tsx-level proof that the 5 draft-access callbacks are ACTUALLY threaded to the runtime.
 *
 * These props are all optional on AppShellProps/MainScreenProps (so EmbedReader/MainScreen/AppShell
 * could build and pass every test green while App.tsx simply never wired them — exactly the gap this
 * suite exists to catch). Spies on the REAL `AppRuntime.prototype` methods (rather than mocking the
 * whole module) so this proves the actual wiring in App.tsx, not a stand-in: <App/> constructs one
 * real `AppRuntime` instance per mount (App.tsx's `setup()` effect), and `runtimeRef.current` is
 * assigned to it synchronously (no `await` precedes that assignment — see App.tsx around
 * `const runtime = new AppRuntime({...}); runtimeRef.current = runtime;`), so it is already set by
 * the time the initial render's effects have flushed.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import App from '../App';
import {AppShell} from '../src/app';
import {AppRuntime} from '../src/app/AppRuntime';

describe('App.tsx — draft-access callbacks are threaded to the runtime (Phase 5§D wiring gap)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('onGetDraftAccessState calls runtime.getDraftAccessState', async () => {
    const spy = jest.spyOn(AppRuntime.prototype, 'getDraftAccessState').mockResolvedValue('approved');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<App />); });
    await act(async () => { await Promise.resolve(); });

    const shell = tree.root.findByType(AppShell);
    expect(shell.props.onGetDraftAccessState).toBeInstanceOf(Function);
    const result = await (shell.props.onGetDraftAccessState as (id: string) => Promise<string>)('draft-1');
    expect(spy).toHaveBeenCalledWith('draft-1');
    expect(result).toBe('approved');

    act(() => { tree.unmount(); });
  });

  it('onGetMyDraftDelivery calls runtime.getMyDraftDelivery with (draftId, ownerPubkey)', async () => {
    const snapshot = {b: 'the body'};
    const spy = jest.spyOn(AppRuntime.prototype, 'getMyDraftDelivery').mockResolvedValue(snapshot);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<App />); });
    await act(async () => { await Promise.resolve(); });

    const shell = tree.root.findByType(AppShell);
    const result = await (shell.props.onGetMyDraftDelivery as (id: string, owner?: string) => Promise<unknown>)('draft-1', 'owner-pk');
    expect(spy).toHaveBeenCalledWith('draft-1', 'owner-pk');
    expect(result).toBe(snapshot);

    act(() => { tree.unmount(); });
  });

  it('onRequestDraftAccess calls runtime.requestDraftAccess with (draftId, ownerPubkey)', async () => {
    const spy = jest.spyOn(AppRuntime.prototype, 'requestDraftAccess').mockResolvedValue(undefined);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<App />); });
    await act(async () => { await Promise.resolve(); });

    const shell = tree.root.findByType(AppShell);
    await (shell.props.onRequestDraftAccess as (id: string, owner: string) => Promise<void>)('draft-1', 'owner-pk');
    expect(spy).toHaveBeenCalledWith('draft-1', 'owner-pk');

    act(() => { tree.unmount(); });
  });

  it('onGetDraftThread calls runtime.getDraftThread', async () => {
    const nodes = [{event: {id: 'c1'}} as unknown];
    const spy = jest.spyOn(AppRuntime.prototype, 'getDraftThread').mockReturnValue(nodes as never);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<App />); });
    await act(async () => { await Promise.resolve(); });

    const shell = tree.root.findByType(AppShell);
    const result = (shell.props.onGetDraftThread as (id: string) => unknown)('share-1');
    expect(spy).toHaveBeenCalledWith('share-1');
    expect(result).toBe(nodes);

    act(() => { tree.unmount(); });
  });

  it('onGetDraftCommentCount calls runtime.getDraftCommentCount', async () => {
    const spy = jest.spyOn(AppRuntime.prototype, 'getDraftCommentCount').mockReturnValue(4);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<App />); });
    await act(async () => { await Promise.resolve(); });

    const shell = tree.root.findByType(AppShell);
    const result = (shell.props.onGetDraftCommentCount as (id: string) => number)('share-1');
    expect(spy).toHaveBeenCalledWith('share-1');
    expect(result).toBe(4);

    act(() => { tree.unmount(); });
  });

  it('the owner-side Manage-access callbacks (queue/granted/approve/deny/revoke) are also threaded', async () => {
    const qSpy = jest.spyOn(AppRuntime.prototype, 'getDraftAccessQueue').mockReturnValue([{pubkey: 'p1', reqId: 'r1', at: 1}]);
    const gSpy = jest.spyOn(AppRuntime.prototype, 'getDraftAccessGranted').mockReturnValue([{pubkey: 'p2', at: 2}]);
    const aSpy = jest.spyOn(AppRuntime.prototype, 'approveDraftAccess').mockResolvedValue(undefined);
    const dSpy = jest.spyOn(AppRuntime.prototype, 'denyDraftAccess').mockResolvedValue(undefined);
    const rSpy = jest.spyOn(AppRuntime.prototype, 'revokeDraftAccess').mockResolvedValue(undefined);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<App />); });
    await act(async () => { await Promise.resolve(); });

    const shell = tree.root.findByType(AppShell);
    expect((shell.props.onGetDraftAccessQueue as (id: string) => unknown[])('draft-1')).toEqual([{pubkey: 'p1', reqId: 'r1', at: 1}]);
    expect(qSpy).toHaveBeenCalledWith('draft-1');
    expect((shell.props.onGetDraftAccessGranted as (id: string) => unknown[])('draft-1')).toEqual([{pubkey: 'p2', at: 2}]);
    expect(gSpy).toHaveBeenCalledWith('draft-1');
    await (shell.props.onApproveDraftAccess as (id: string, pk: string) => Promise<void>)('draft-1', 'p1');
    expect(aSpy).toHaveBeenCalledWith('draft-1', 'p1');
    await (shell.props.onDenyDraftAccess as (id: string, pk: string) => Promise<void>)('draft-1', 'p1');
    expect(dSpy).toHaveBeenCalledWith('draft-1', 'p1');
    await (shell.props.onRevokeDraftAccess as (id: string, pk: string) => Promise<void>)('draft-1', 'p2');
    expect(rSpy).toHaveBeenCalledWith('draft-1', 'p2');

    act(() => { tree.unmount(); });
  });
});

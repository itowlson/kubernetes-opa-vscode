import * as vscode from 'vscode';
import * as k8s from 'vscode-kubernetes-tools-api';
import { showUnavailable, longRunning } from '../utils/host';
import { listPolicies, ConfigMap, policyIsDevRego } from '../opa';
import { failed, Errorable, Failed, succeeded } from '../utils/errorable';
import { partition } from '../utils/array';
import { basename } from 'path';

export async function syncFromWorkspace() {
    const kubectl = await k8s.extension.kubectl.v1;
    if (!kubectl.available) {
        await showUnavailable(kubectl.reason);
        return;
    }

    await trySyncFromWorkspace(kubectl.api);
}

async function trySyncFromWorkspace(kubectl: k8s.KubectlV1): Promise<void> {
    // Strategy:
    // * Find all the .rego files in the workspace
    // * Look at all the configmaps in the cluster (except system ones)
    // * Deploy all the .rego files EXCEPT those that would overwrite a NON-MANAGED configmap
    //   * TODO: OPTIMISATION: Skip .rego files where the data already matches the .rego file content
    // * Delete all the MANAGED configmaps that do NOT correspond to any .rego file
    // TO CONSIDER: List what we are going to do first...

    const plan = await longRunning('Working out sync actions...', () => syncActions(kubectl));
    if (failed(plan)) {
        await vscode.window.showErrorMessage(plan.error[0]);
        return;
    }

    const actions = plan.result;

    // TODO: type assertions are ugly
    const deployQuickPicks: ActionQuickPickItem[] = actions.deploy.map((f) => ({label: `${f}: deploy to cluster`, picked: true, value: f, action: 'deploy'}));
    const overwriteDevRegoQuickPicks: ActionQuickPickItem[] = actions.overwriteDevRego.map((f) => ({label: `${f}: deploy to cluster (overwriting existing)`, picked: true, value: f, action: 'deploy'}));
    const overwriteNonDevRegoQuickPicks: ActionQuickPickItem[] = actions.overwriteNonDevRego.map((f) => ({label: `${f}: deploy to cluster (overwriting existing not deployed by VS Code)`, picked: false, value: f, action: 'deploy'}));
    const deleteQuickPicks: ActionQuickPickItem[] = actions.delete.map((p) => ({label: `${p}: delete from cluster`, picked: true, value: p, action: 'delete'}));

    const actionQuickPicks = deployQuickPicks.concat(overwriteDevRegoQuickPicks).concat(overwriteNonDevRegoQuickPicks).concat(deleteQuickPicks);
    const selectedActionQuickPicks = await vscode.window.showQuickPick(actionQuickPicks, { canPickMany: true });

    if (!selectedActionQuickPicks || selectedActionQuickPicks.length === 0) {
        return;
    }

    const selectedActions = selectedActionQuickPicks.map((a) => ({ value: a.value, action: a.action }));
    const selectedActionPromises = selectedActions.map((a) => runAction(kubectl, a));
    const actionResults = await longRunning('Syncing the cluster from the workspace...', () =>
        Promise.all(selectedActionPromises)
    );

    const failures = actionResults.filter((r) => failed(r)) as Failed[];
    if (failures.length > 0) {
        const successCount = actionResults.filter((r) => succeeded(r)).length;
        const successCountInfo = successCount > 0 ? `.  (${successCount} other update(s) succeeded.)` : '';
        await vscode.window.showErrorMessage(`${failures.length} update(s) failed: ${failures.map((f) => f.error[0]).join(', ')}${successCountInfo}`);
        return;
    }

    await vscode.window.showInformationMessage(`Synced the cluster from the workspace`);
}

function runAction(kubectl: k8s.KubectlV1, action: { value: string, action: 'deploy' | 'delete' }): Promise<Errorable<null>> {
    switch (action.action) {
        case 'deploy': return runDeployAction(kubectl, action.value);
        case 'delete': return runDeleteAction(kubectl, action.value);
    }
}

interface SyncActions {
    readonly deploy: ReadonlyArray<string>;
    readonly overwriteDevRego: ReadonlyArray<string>;
    readonly overwriteNonDevRego: ReadonlyArray<string>;
    readonly delete: ReadonlyArray<string>;
}

interface ActionQuickPickItem extends vscode.QuickPickItem {
    readonly value: string;
    readonly action: 'deploy' | 'delete';
}

async function syncActions(kubectl: k8s.KubectlV1): Promise<Errorable<SyncActions>> {
    const regoUris = await vscode.workspace.findFiles('**/*.rego');
    const clusterPolicies = await listPolicies(kubectl);

    const nonFileRegoUris = regoUris.filter((u) => u.scheme !== 'file');
    if (nonFileRegoUris.length > 0) {
        const message = nonFileRegoUris.map((u) => u.toString()).join(', ');
        return { succeeded: false, error: [`Workspace contains .rego documents that aren't files. Save all .rego documents to the file system and try again. (${message})`] };
    }

    if (failed(clusterPolicies)) {
        return { succeeded: false, error: [`Failed to get current policies: ${clusterPolicies.error[0]}`] };
    }

    const localRegoFiles = regoUris.map((u) => vscode.workspace.asRelativePath(u));

    const fileActions = partition(localRegoFiles, (f) => deploymentAction(clusterPolicies.result, f));
    const filesToDeploy = fileActions.get('no-overwrite') || [];
    const filesOverwritingDevRego = fileActions.get('overwrite-dev') || [];
    const filesOverwritingNonDevRego = fileActions.get('overwrite-nondev') || [];
    const policiesToDelete = clusterPolicies.result
                                            .filter((p) => policyIsDevRego(p) && !hasMatchingRegoFile(localRegoFiles, p))
                                            .map((p) => p.metadata.name);

    return {
        succeeded: true,
        result: {
            deploy: filesToDeploy,
            overwriteDevRego: filesOverwritingDevRego,
            overwriteNonDevRego: filesOverwritingNonDevRego,
            delete: policiesToDelete
        }
    };
}

function deploymentAction(policies: ReadonlyArray<ConfigMap>, regoFilePath: string): 'no-overwrite' | 'overwrite-dev' | 'overwrite-nondev' {
    const policyName = basename(regoFilePath, '.rego');
    const matchingPolicy = policies.find((p) => p.metadata.name === policyName);
    if (!matchingPolicy) {
        return 'no-overwrite';
    }
    return policyIsDevRego(matchingPolicy) ? 'overwrite-dev' : 'overwrite-nondev';
}

function hasMatchingRegoFile(regoFiles: ReadonlyArray<string>, policy: ConfigMap): boolean {
    return regoFiles.some((f) => basename(f, '.rego') === policy.metadata.name);
}

async function runDeployAction(kubectl: k8s.KubectlV1, regoFilePath: string): Promise<Errorable<null>> {
    return { succeeded: true, result: null };
}

async function runDeleteAction(kubectl: k8s.KubectlV1, policyName: string): Promise<Errorable<null>> {
    return { succeeded: false, error: [`Didn't even try very hard to delete ${policyName}`] };
}

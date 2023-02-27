/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import { IS_WINDOWS, STATUS_BAR_PRIORITY_START } from '../constants';
import { disposeSubscriptions, listCoreSerialPorts } from '../utils';
import { getProjectItemState, updateProjectItemState } from './helpers';
import ProjectTasksTreeProvider from './task-tree';
import { extension } from '../main';
import path from 'path';
import vscode from 'vscode';

export default class ProjectTaskManager {
  static PROVIDER_TYPE = 'PlatformIO';
  static TASKS_VIEW_ID = 'platformio-ide.projectTasks';
  static AUTO_REFRESH_DELAY = 500; // 0.5 sec

  constructor(projectDir, projectObserver) {
    this.projectDir = projectDir;
    this.projectObserver = projectObserver;
    this.subscriptions = [];

    this._sid = Math.random();
    this._refreshTimeout = undefined;
    this._ranTask = undefined;
    this._tasksToRestore = [];
    this._sbPortSwitcher = undefined;
    this._customPort = getProjectItemState(projectDir, 'customPort');

    this.refresh();
  }

  dispose() {
    disposeSubscriptions(this.subscriptions);
  }

  requestRefresh() {
    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
    }
    this._refreshTimeout = setTimeout(
      this.refresh.bind(this),
      ProjectTaskManager.AUTO_REFRESH_DELAY
    );
  }

  async refresh({ force = false } = {}) {
    this.dispose();

    if (force) {
      this.projectObserver.resetCache();
      this._sid = Math.random();
    }

    const projectEnvs = await this.projectObserver.getProjectEnvs();
    const projectTasks = [...(await this.projectObserver.getDefaultTasks())];
    for (const item of projectEnvs) {
      projectTasks.push(
        ...((await this.projectObserver.getLoadedEnvTasks(item.name)) || [])
      );
    }

    const taskViewer = vscode.window.createTreeView(ProjectTaskManager.TASKS_VIEW_ID, {
      treeDataProvider: new ProjectTasksTreeProvider(
        this._sid,
        projectEnvs,
        projectTasks,
        this.projectObserver.getActiveEnvName()
      ),
      showCollapseAll: true,
    });

    this.subscriptions.push(
      taskViewer,

      // pre-fetch expanded env tasks
      taskViewer.onDidExpandElement(async ({ element }) => {
        if (element.env) {
          await this.onDidRequestEnvTasks(element.env);
        }
      }),

      // register VSCode Task Provider
      vscode.tasks.registerTaskProvider(ProjectTaskManager.PROVIDER_TYPE, {
        provideTasks: () => projectTasks.map((task) => this.toVSCodeTask(task)),
        resolveTask: () => {
          return undefined;
        },
      }),

      vscode.tasks.onDidEndTaskProcess((event) => this.onDidEndTaskProcess(event))
    );

    this.registerTaskBasedCommands(projectTasks);
    this.registerPortSwitcher();
    vscode.commands.executeCommand(
      'setContext',
      'pioMultiEnvProject',
      projectEnvs.length > 1
    );
  }

  async onDidRequestEnvTasks(name) {
    if (await this.projectObserver.getLoadedEnvTasks(name)) {
      return;
    }
    await this.projectObserver.loadEnvTasks(name);
    return this.requestRefresh();
  }

  toVSCodeTask(projectTask) {
    const envClone = Object.assign({}, process.env);
    if (process.env.PLATFORMIO_PATH) {
      envClone.PATH = process.env.PLATFORMIO_PATH;
      envClone.Path = process.env.PLATFORMIO_PATH;
    }
    const vscodeTask = new vscode.Task(
      {
        type: ProjectTaskManager.PROVIDER_TYPE,
        task: projectTask.id,
      },
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.projectDir)),
      projectTask.id,
      ProjectTaskManager.PROVIDER_TYPE,
      new vscode.ProcessExecution(
        IS_WINDOWS ? 'platformio.exe' : 'platformio',
        projectTask.getCoreArgs({ port: this._customPort }),
        {
          cwd: this.projectDir,
          env: envClone,
        }
      ),
      '$platformio'
    );
    vscodeTask.presentationOptions = {
      panel: vscode.TaskPanelKind.Dedicated,
    };
    if (projectTask.isBuild()) {
      vscodeTask.group = vscode.TaskGroup.Build;
    } else if (projectTask.isClean()) {
      vscodeTask.group = vscode.TaskGroup.Clean;
    } else if (projectTask.isTest()) {
      vscodeTask.group = vscode.TaskGroup.Test;
    }
    return vscodeTask;
  }

  runTask(task) {
    this._ranTask = task;
    this._tasksToRestore = [];
    this._autoCloseSerialMonitor();
    // use string-based task defination for Win 7 // issue #3481
    vscode.commands.executeCommand(
      'workbench.action.tasks.runTask',
      `${ProjectTaskManager.PROVIDER_TYPE}: ${task.id}`
    );
  }

  _autoCloseSerialMonitor() {
    const closeMonitorConds = [
      extension.getConfiguration('autoCloseSerialMonitor'),
      ['upload', 'test'].some((arg) => this._ranTask.args.includes(arg)),
    ];
    if (!closeMonitorConds.every((value) => value)) {
      return;
    }
    vscode.tasks.taskExecutions.forEach((event) => {
      const isCurrentEvent = this.areTasksEqual(this._ranTask, event.task);
      const skipConds = [
        // skip non-PlatformIO task
        event.task.definition.type !== ProjectTaskManager.PROVIDER_TYPE,
        !event.task.execution.args.includes('monitor'),
        this.isMonitorAndUploadTask(event.task) && !isCurrentEvent,
      ];
      if (skipConds.some((value) => value)) {
        return;
      }
      if (!isCurrentEvent) {
        this._tasksToRestore.push(event.task);
      }
      event.terminate();
    });
  }

  onDidEndTaskProcess(event) {
    const skipConds = [
      !this._ranTask,
      !this.areTasksEqual(this._ranTask, event.execution.task),
      event.exitCode !== 0,
      !this._tasksToRestore.length,
    ];
    if (skipConds.some((value) => value)) {
      return;
    }
    this._ranTask = undefined;
    setTimeout(() => {
      while (this._tasksToRestore.length) {
        vscode.tasks.executeTask(this._tasksToRestore.pop());
      }
    }, parseInt(extension.getConfiguration('reopenSerialMonitorDelay')));
  }

  isMonitorAndUploadTask(task) {
    const args = task.args || task.execution.args;
    return ['--target', 'upload', 'monitor'].every((arg) => args.includes(arg));
  }

  areTasksEqual(task1, task2) {
    if (!task1 || !task2) {
      return task1 === task2;
    }
    const args1 = task1.args || task1.execution.args || [];
    const args2 = task2.args || task2.execution.args || [];
    return (
      args1.length === args2.length &&
      args1.every((value, index) => value === args2[index])
    );
  }

  registerTaskBasedCommands(tasks) {
    const _runTask = (name) => {
      const candidates = tasks.filter(
        (task) =>
          task.name === name && task.coreEnv === this.projectObserver.getActiveEnvName()
      );
      this.runTask(candidates[0]);
    };

    this.subscriptions.push(
      vscode.commands.registerCommand('platformio-ide.build', () => _runTask('Build')),
      vscode.commands.registerCommand('platformio-ide.upload', () =>
        _runTask('Upload')
      ),
      vscode.commands.registerCommand('platformio-ide.uploadAndMonitor', () =>
        _runTask('Upload and Monitor')
      ),
      vscode.commands.registerCommand('platformio-ide.test', () => _runTask('Test')),
      vscode.commands.registerCommand('platformio-ide.clean', () => _runTask('Clean')),
      vscode.commands.registerCommand('platformio-ide.serialMonitor', () =>
        _runTask('Monitor')
      ),
      vscode.commands.registerCommand('platformio-ide.remoteUpload', () =>
        _runTask('Remote Upload')
      )
    );
  }

  registerPortSwitcher() {
    this._sbPortSwitcher = vscode.window.createStatusBarItem(
      'pio-port-switcher',
      vscode.StatusBarAlignment.Left,
      STATUS_BAR_PRIORITY_START
    );
    this._sbPortSwitcher.name = 'PlatformIO: Port Switcher';
    this._sbPortSwitcher.tooltip = 'Set upload/monitor/test port';
    this._sbPortSwitcher.command = 'platformio-ide.setProjectPort';
    this.switchPort(this._customPort);

    this.subscriptions.push(
      this._sbPortSwitcher,
      vscode.commands.registerCommand('platformio-ide.setProjectPort', () =>
        this.pickProjectPort()
      )
    );
  }

  async pickProjectPort() {
    const serialPorts = await listCoreSerialPorts();
    const pickedItem = await vscode.window.showQuickPick(
      [
        { label: 'Auto' },
        ...serialPorts.map((port) => ({
          label: port.port,
          description: [port.description, port.hwid]
            .filter((value) => !!value)
            .join(' | '),
        })),
        { label: 'Custom...' },
      ],
      {
        matchOnDescription: true,
      }
    );
    if (!pickedItem) {
      return;
    }
    if (pickedItem.label === 'Custom...') {
      const value = await vscode.window.showInputBox({
        title: 'Enter custom upload/monitor/test port',
        placeHolder: 'Examples: COM3, /dev/ttyUSB*, 192.168.0.13, /media/disk',
      });
      if (!value) {
        return;
      }
      this.switchPort(value.trim());
    } else {
      this.switchPort(pickedItem.label !== 'Auto' ? pickedItem.label : undefined);
    }
  }

  switchPort(port = undefined) {
    updateProjectItemState(this.projectDir, 'customPort', port);
    this._customPort = port;
    this._sbPortSwitcher.text = `$(plug) ${
      this._customPort ? path.basename(this._customPort) : 'Auto'
    }`;
    this._sbPortSwitcher.show();
  }
}

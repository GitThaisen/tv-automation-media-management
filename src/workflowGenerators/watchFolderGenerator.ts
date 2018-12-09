import { getCurrentTime, literal, randomId } from '../lib/lib'
import { WorkFlow, WorkFlowSource, WorkStepBase, WorkStepAction } from '../api'
import { LocalStorageGenerator, WorkFlowGeneratorEventType } from './localStorageGenerator'
import { File, StorageObject, StorageEvent, StorageEventType } from '../storageHandlers/storageHandler'
import { TrackedMediaItems } from '../mediaItemTracker'
import { FileWorkStep } from '../work/workStep'

export class WatchFolderGenerator extends LocalStorageGenerator {
	constructor (availableStorage: StorageObject[], tracked: TrackedMediaItems) {
		super(availableStorage, tracked)
	}

	async init (): Promise<void> {
		return Promise.resolve().then(() => {
			this._availableStorage.forEach((item) => {
				if (item.watchFolder && item.watchFolderTargetId) this.registerStorage(item)
			})
		})
	}

	protected generateNewFileWorkSteps (file: File, st: StorageObject): WorkStepBase[] {
		return [
			new FileWorkStep({
				action: WorkStepAction.COPY,
				file: file,
				target: st,
				priority: 1
			})
		]
	}

	protected generateDeleteFileWorkSteps (file: File, st: StorageObject): WorkStepBase[] {
		return [
			new FileWorkStep({
				action: WorkStepAction.DELETE,
				file: file,
				target: st,
				priority: 1
			})
		]
	}

	private onFileUpdated (st: StorageObject, e: StorageEvent) {
		if (!e.file) throw new Error(`Invalid event type or arguments.`)
		const localFile = e.file
		const targetStorage = this._availableStorage.find((i) => i.id === st.watchFolderTargetId)
		if (!targetStorage) throw new Error(`Could not find target storage "${st.watchFolderTargetId}"`)
		this._tracked.getById(e.path).then(() => {
			this.emit('debug', `File "${e.path}" is already tracked, "${st.id}" ignoring.`)

			return Promise.resolve()
		}, () => {
			return this.registerFile(localFile, st).then(() => {
				this.emit('debug', `File "${e.path}" has started to be tracked by ${this.constructor.name} for "${st.id}".`)
			}).catch((e) => {
				this.emit('error', `Tracked file registration failed: ${e}`)
			})
		}).then(() => {
			const emitCopy = () => {
				const workflowId = e.path + '_' + randomId()
				this.emit(WorkFlowGeneratorEventType.NEW_WORKFLOW, literal<WorkFlow>({
					_id: workflowId,
					finished: false,
					priority: 1,
					source: WorkFlowSource.LOCAL_MEDIA_ITEM,
					steps: this.generateNewFileWorkSteps(localFile, targetStorage),
					created: getCurrentTime(),
					success: false
				}))
				this.emit('debug', `New forkflow started for "${e.path}": "${workflowId}".`)
			}

			return targetStorage.handler.getFile(localFile.name).then((file) => {
				return file.getProperties().then((properties) => {
					return localFile.getProperties().then((localProperties) => {
						if (localProperties.size !== properties.size) {
							emitCopy()
						}
					})
				})
			}, () => {
				emitCopy()
			})
		})
	}

	protected onAdd (st: StorageObject, e: StorageEvent, initialScan?: boolean) {
		return this.onFileUpdated(st, e)
	}

	protected onChange (st: StorageObject, e: StorageEvent) {
		return this.onAdd(st, e)
	}

	protected onDelete (st: StorageObject, e: StorageEvent, initialScan?: boolean) {
		this._tracked.getById(e.path).then((tmi) => {
			if (tmi.sourceStorageId === st.id) {
				tmi.targetStorageIds.forEach((sId) => {
					const storageObject = this._availableStorage.find((as) => as.id === sId)
					if (storageObject) {
						storageObject.handler.getFile(tmi.name).then((file) => {
							const workflowId = e.path + '_' + randomId()
							this.emit(WorkFlowGeneratorEventType.NEW_WORKFLOW, literal<WorkFlow>({
								_id: workflowId,
								finished: false,
								priority: 1,
								source: WorkFlowSource.LOCAL_MEDIA_ITEM,
								steps: this.generateDeleteFileWorkSteps(file, storageObject),
								created: getCurrentTime(),
								success: false
							}))
							// return storageObject.handler.deleteFile(file)
						}).then(() => {
							this.emit('debug', `New workflow to delete file "${tmi.name}" from target storage "${storageObject.id}"`)
						}).catch((e) => {
							this.emit('warn', `Could not find file in target storage: "${storageObject.id}": ${e}`)
						})
					}
				})
				this._tracked.remove(tmi).then(() => {
					this.emit('debug', `Tracked file "${e.path}" deleted from storage "${st.id}" became untracked.`)
				}, (e) => {
					this.emit('error', `Tracked file "${e.path}" deleted from storage "${st.id}" could not become untracked: ${e}`)
				})
			}
			// TODO: generate a pull from sourceStorage?
		}, (e) => {
			this.emit('debug', `Untracked file "${e.path}" deleted from storage "${st.id}".`)
		})
	}

	protected async initialCheck (st: StorageObject): Promise<void> {
		const initialScanTime = getCurrentTime()
		const targetStorage = this._availableStorage.find((i) => i.id === st.watchFolderTargetId)
		if (!targetStorage) throw new Error(`Target storage "${st.watchFolderTargetId}" not found!`)

		return st.handler.getAllFiles().then((allFiles) => {
			return Promise.all(allFiles.map(async (file): Promise<void> => {
				try {
					const trackedFile = await this._tracked.getById(file.name)
					if (trackedFile.sourceStorageId === st.id) {
						trackedFile.lastSeen = initialScanTime
						try {
							await this._tracked.put(trackedFile)
						} catch (e1) {
							this.emit('error', `Could not update "${trackedFile.name}" last seen: ${e1}`)
						}

						await targetStorage.handler.getFile(trackedFile.name)
					}
				} catch (e) {
					this.onAdd(st, {
						type: StorageEventType.add,
						path: file.name,
						file: file
					})
				}
				this.emit('debug', `Finished handling file: ${file.name}`)
			}))
		}).then(async () => {
			const staleFiles = await this._tracked.getAllFromStorage(st.id, {
				lastSeen: {
					$lt: initialScanTime
				}
			})
			staleFiles.map((sFile) => {
				this.onDelete(st, {
					type: StorageEventType.delete,
					path: sFile.name
				})
			})
		})
	}
}
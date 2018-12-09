import { EventEmitter } from 'events'

export enum WorkFlowGeneratorEventType {
	NEW_WORKFLOW = 'newworkflow'
}

export abstract class BaseWorkFlowGenerator extends EventEmitter {
	constructor () {
		super()

		// TODO: generic setup
	}

	abstract async init (): Promise<void>
	abstract async destroy (): Promise<void>
}
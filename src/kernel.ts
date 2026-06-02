// Copyright (c) JupyterLite Contributors
// Distributed under the terms of the Modified BSD License.

import { KernelMessage } from '@jupyterlab/services';
import { IKernel } from '@jupyterlite/services';
import { IKernelSpecs } from '@jupyterlite/services';
import { PromiseDelegate } from '@lumino/coreutils';

import type { ISignal } from '@lumino/signaling';
import { Signal } from '@lumino/signaling';

import { replace_code_in_msg } from './message_utils';

// a map from kernel-name (string)
// to kernel-info-response
// we use this to determine which CodeMirror language extension to use for a given kernel
export const kernelInfos: { [key: string]: KernelMessage.IInfoReply } = {};

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class PolyglottKernel implements IKernel {
  constructor(options: IKernel.IOptions, kernelspecs: IKernelSpecs) {
    this.kernelSpecs = kernelspecs;
    console.log('Creating kernel with options', options);
    const { id, name, location, sendMessage } = options;
    this._id = id;
    this._name = name;
    this._location = location;
    this._sendMessage = sendMessage;
  }

  /**
   * Get the kernel id
   */
  get id(): string {
    return this._id;
  }

  /**
   * Get the name of the kernel
   */
  get name(): string {
    return this._name;
  }

  /**
   * The location in the virtual filesystem from which the kernel was started.
   */
  get location(): string {
    return this._location;
  }

  get ready(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Return whether the kernel is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * A signal emitted when the kernel is disposed.
   */
  get disposed(): ISignal<this, void> {
    return this._disposed;
  }

  /**
   * Dispose the kernel.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._disposed.emit(void 0);
  }
  /**
   * Send an `error` message to the client.
   *
   * @param parentHeader The parent header.
   * @param content The error content.
   */
  protected publishExecuteError(
    content: KernelMessage.IErrorMsg['content'],
    parentHeader:
      | KernelMessage.IHeader<KernelMessage.MessageType>
      | undefined = undefined
  ): void {
    const parentHeaderValue = parentHeader ?? this._parentHeader;
    const message = KernelMessage.createMessage<KernelMessage.IErrorMsg>({
      channel: 'iopub',
      msgType: 'error',
      // TODO: better handle this
      session: parentHeaderValue?.session ?? '',
      parentHeader: parentHeaderValue,
      content
    });
    this._sendMessage(message);
  }

  private _send_status(
    parent: KernelMessage.IMessage,
    status: 'idle' | 'busy'
  ): void {
    const message = KernelMessage.createMessage<KernelMessage.IStatusMsg>({
      msgType: 'status',
      session: parent.header.session,
      parentHeader: parent.header,
      channel: 'iopub',
      content: {
        execution_state: status
      }
    });
    this._sendMessage(message);
  }

  // each kernel gets a sendMessage function that it can use to send messages back to the server.
  // this method is given to the "sub-kernels" to send messages back to the server.
  // we intercept these messages here and then forward them to the server, but we could also do some processing here if needed.
  private _sendMessageDispatch(
    msg: KernelMessage.IMessage,
    kernelName: string
  ): void {
    // when the kernel asks to create a comm, we store the comm id to kernel name association in the commIdToKernelName map, so we can forward comm messages to the correct kernel
    if (msg.header.msg_type === 'comm_open') {
      const commOpenMsg = msg as KernelMessage.ICommOpenMsg;
      const commId = commOpenMsg.content.comm_id;
      this.commIdToKernelName.set(commId, kernelName);
      console.log(`Registered comm_id ${commId} for kernel ${kernelName}`);
    } else if (msg.header.msg_type === 'kernel_info_reply') {
      const kernelInfoReplyMsg = msg as KernelMessage.IInfoReplyMsg;
      const content = kernelInfoReplyMsg.content as KernelMessage.IInfoReply;
      console.log(
        'Received kernel_info_reply from kernel',
        kernelName,
        'with content',
        content
      );
      kernelInfos[kernelName] = content;
    }
    // is this a complete_reply message? if so, we need to adjust the cursor position in the reply to account for the removed magic line
    else if (msg.header.msg_type === 'complete_reply') {
      const complete_reply_msg = msg as KernelMessage.ICompleteReplyMsg;
      const content = complete_reply_msg.content as any;
      console.log(
        'Received complete_reply from kernel',
        kernelName,
        'with content',
        content,
        'current cursor offset',
        this._completeReplyCurserOffset
      );
      if (this._completeReplyCurserOffset !== 0) {
        const newCursorStart =
          content.cursor_start + this._completeReplyCurserOffset;
        const newCursorEnd =
          content.cursor_end + this._completeReplyCurserOffset;
        complete_reply_msg.content = {
          ...content,
          cursor_start: newCursorStart,
          cursor_end: newCursorEnd
        };
        console.log(
          'Adjusted complete_reply cursor positions to account for removed magic line, new content:',
          complete_reply_msg.content
        );
      }
      this._sendMessage(complete_reply_msg);
      this._completeReplyPromise.resolve();
      return;
    } else if (msg.header.msg_type === 'comm_info_reply') {
      const commInfoReplyMsg = msg as KernelMessage.ICommInfoReplyMsg;
      const content = commInfoReplyMsg.content as any;
      console.log(
        'Received comm_info_reply from kernel',
        kernelName,
        'with content',
        content
      );
      this._commInfoRepliesContent.push(content);

      if (this._commInfoRepliesContent.length === this.startedKernels.size) {
        this._commInfoReplyPromise.resolve();
      }
    }

    console.log(
      `Kernel ${kernelName} sending message ${msg.header.msg_type} with content`,
      msg.content
    );
    this._sendMessage(msg);
  }

  // helper to get the kernel from name
  protected async getKernelByName(
    kernelName: string
  ): Promise<IKernel | undefined> {
    if (!this.startedKernels.has(kernelName)) {
      if (!this.kernelSpecs.factories.has(kernelName)) {
        console.warn(
          `kernel ${kernelName} not found, available kernels are:`,
          Array.from(this.kernelSpecs.factories.keys())
        );
        return undefined;
      }

      const factory = this.kernelSpecs.factories.get(kernelName)!;
      const sendMessage = (msg: KernelMessage.IMessage) =>
        this._sendMessageDispatch(msg, kernelName);

      const options = {
        id: `${kernelName}-1`,
        name: kernelName,
        location: this._location,
        sendMessage: sendMessage
      };
      console.log('Creating kernel with options', options);
      const kernel = await factory(options);

      // request a kernel_info from the kernel so it can send us the info reply which we use to determine which CodeMirror language extension to use for this kernel
      const kernelInfoRequestMsg =
        KernelMessage.createMessage<KernelMessage.IInfoRequestMsg>({
          msgType: 'kernel_info_request',
          channel: 'shell',
          session: this._parentHeader?.session ?? '',
          parentHeader: this._parentHeader,
          content: {}
        });

      console.log('Created kernel !!!! waiting for it to be ready', kernel);
      await kernel.ready;

      console.log(
        'Kernel is ready, sending kernel_info_request message to kernel',
        kernelName,
        kernelInfoRequestMsg
      );
      kernel.handleMessage(kernelInfoRequestMsg);

      console.log('Created kernel', kernel);
      this.startedKernels.set(kernelName, kernel);
      return kernel;
    } else {
      return this.startedKernels.get(kernelName);
    }
  }

  private get_kernel_name_from_magic(code: string): string | undefined {
    // get first line which must be a magic like %%kernel xeus-python
    const firstLine = code.split('\n')[0].trim();
    if (!firstLine.startsWith('%%kernel')) {
      return undefined;
    }
    try {
      const kernelName = firstLine.split(' ')[1];
      return kernelName;
    } catch (e) {
      return undefined;
    }
  }

  private _remove_kernel_magic(
    msg: KernelMessage.IMessage
  ): KernelMessage.IMessage {
    const code = (msg.content as any).code as string;
    return replace_code_in_msg(msg, code.split('\n').slice(1).join('\n'));
  }

  private async _execute(msg: KernelMessage.IMessage): Promise<void> {
    const executeMsg = msg as KernelMessage.IExecuteRequestMsg;

    this._parentHeader = executeMsg.header;

    const content =
      executeMsg.content as KernelMessage.IExecuteRequestMsg['content'];

    if (content.store_history) {
      this._executionCount++;
      console.log('Execution count incremented to', this._executionCount);
    }
    if (content.store_history) {
      this._history.push([0, 0, content.code]);
    }
    const code = content.code;
    const kernelName = this.get_kernel_name_from_magic(code);
    if (!kernelName) {
      const availableKernels = Array.from(
        this.kernelSpecs.factories.keys()
      ).join(', ');

      this.publishExecuteError(
        {
          ename: 'InvalidMagic',
          evalue: `No magic found in first line of code, expected  %%kernel <KERNEL_NAME>, but got: ${code.split('\n')[0].trim()} \nAvailable kernels are: ${availableKernels}`,
          traceback: []
        },
        msg.header
      );
      return;
    }
    const kernel = await this.getKernelByName(kernelName);
    if (!kernel) {
      const availableKernels = Array.from(
        this.kernelSpecs.factories.keys()
      ).join(', ');
      this.publishExecuteError(
        {
          ename: 'KernelNotFound',
          evalue: `Kernel ${kernelName} not found, available kernels are: ${availableKernels}`,
          traceback: []
        },
        msg.header
      );
      return;
    }

    console.log(`Forwarding code to kernel ${kernelName}`, code);
    const newMsg = this._remove_kernel_magic(msg);
    await kernel.handleMessage(newMsg);
  }

  private async _kernelInfo(parent: KernelMessage.IMessage): Promise<void> {
    // const content_raw = {
    //     implementation: 'polyglott',
    //     implementation_version: '0.1.0',
    //     language_info: {
    //         name: 'polyglott',
    //         version: '0.1.0',
    //         mimetype: 'text/x-polyglott',
    //         file_extension: '.pg',
    //     },
    //     banner: 'Polyglott Kernel',
    // }
    // const content = content_raw as KernelMessage.IInfoReplyMsg['content'];

    const content: KernelMessage.IInfoReplyMsg['content'] = {
      implementation: 'polyglott',
      implementation_version: '0.1.0',
      language_info: {
        name: 'polyglott',
        version: '0.1.0',
        mimetype: 'application/x-polyglott',
        file_extension: '.pg'
      },
      banner: 'Polyglott Kernel',
      protocol_version: '5.3',
      help_links: [],
      status: 'ok'
    };

    const message = KernelMessage.createMessage<KernelMessage.IInfoReplyMsg>({
      msgType: 'kernel_info_reply',
      channel: 'shell',
      session: parent.header.session,
      parentHeader:
        parent.header as KernelMessage.IHeader<'kernel_info_request'>,
      content
    });

    this._sendMessage(message);
  }

  private async _isComplete(msg: KernelMessage.IMessage): Promise<void> {
    const code = (msg as KernelMessage.IIsCompleteRequestMsg).content.code;
    const kernelName = this.get_kernel_name_from_magic(code);
    const reply_content: KernelMessage.IIsCompleteReplyMsg['content'] = {
      status: 'invalid'
    };
    const reply_msg =
      KernelMessage.createMessage<KernelMessage.IIsCompleteReplyMsg>({
        msgType: 'is_complete_reply',
        channel: 'shell',
        session: msg.header.session,
        parentHeader:
          msg.header as KernelMessage.IHeader<'is_complete_request'>,
        content: reply_content
      });
    if (!kernelName) {
      // send response with "invalid" status
      reply_msg.content.status = 'invalid';
      this._sendMessage(reply_msg);
      return;
    }

    // remove magic from code
    const codeWithoutMagic = code.split('\n').slice(1).join('\n');
    if (codeWithoutMagic.trim().length === 0) {
      // if there is no code after the magic, we consider it complete
      reply_content.status = 'complete';
      this._sendMessage(reply_msg);
      return;
    } else {
      const kernel = await this.getKernelByName(kernelName);
      const newMsg = this._remove_kernel_magic(msg);

      // send message to kernel and wait for response
      if (kernel) {
        await kernel.handleMessage(newMsg);
      }
      this._sendMessage(reply_msg);
      return;
    }
  }

  private async _complete(msg: KernelMessage.IMessage): Promise<void> {
    const code = (msg as KernelMessage.ICompleteRequestMsg).content.code;
    const cursor_pos = (msg as KernelMessage.ICompleteRequestMsg).content
      .cursor_pos;
    const kernelName = this.get_kernel_name_from_magic(code);
    const reply_content: KernelMessage.ICompleteReplyMsg['content'] = {
      status: 'ok',
      matches: [],
      cursor_start: cursor_pos,
      cursor_end: cursor_pos,
      metadata: {}
    };
    const reply_msg =
      KernelMessage.createMessage<KernelMessage.ICompleteReplyMsg>({
        msgType: 'complete_reply',
        channel: 'shell',
        session: msg.header.session,
        content: reply_content
      });
    if (!kernelName) {
      // send response with "invalid" status
      // resolve the _completeReplyPromise
      this._completeReplyPromise.resolve();
      this._sendMessage(reply_msg);
      return;
    }

    const kernel = await this.getKernelByName(kernelName);
    const newMsg = this._remove_kernel_magic(msg);

    // modify the cursor position in the message to account for the removed magic line
    const codeWithoutMagic = (newMsg.content as any).code as string;
    const magicSize = code.length - codeWithoutMagic.length;
    this._completeReplyCurserOffset = magicSize;
    const newCursorPos = cursor_pos - magicSize;
    (newMsg.content as any).cursor_pos = newCursorPos;

    console.log('orginal msg', msg);
    console.log('new msg', newMsg);

    // send message to kernel and wait for response
    if (kernel) {
      await kernel.handleMessage(newMsg);
    }
    this._sendMessage(reply_msg);
    return;
  }
  async commMsg(msg: KernelMessage.ICommMsgMsg): Promise<void> {
    console.log('Received comm_msg', msg);
    const commId = msg.content.comm_id;
    const kernelName = this.commIdToKernelName.get(commId);
    if (!kernelName) {
      console.warn(`Received comm_msg for unknown comm_id ${commId}`);
      return;
    }
    const kernel = await this.getKernelByName(kernelName);
    if (!kernel) {
      console.warn(`Received comm_msg for unknown kernel ${kernelName}`);
      return;
    }
    await kernel.handleMessage(msg);
  }
  async commInfo(msg: KernelMessage.ICommInfoRequestMsg): Promise<void> {
    console.log('Received comm_info_request', msg);
    if (this.startedKernels.size === 0) {
      // if we have no started kernels, we can just reply with an empty comm list
      const reply_msg =
        KernelMessage.createMessage<KernelMessage.ICommInfoReplyMsg>({
          msgType: 'comm_info_reply',
          channel: 'shell',
          session: msg.header.session,
          parentHeader:
            msg.header as KernelMessage.IHeader<'comm_info_request'>,
          content: {
            comms: {},
            status: 'ok'
          }
        });
      this._sendMessage(reply_msg);
      this._commInfoReplyPromise.resolve();
    } else {
      // only iterate over values not keys
      for (const kernel of this.startedKernels.values()) {
        await kernel.handleMessage(msg);
      }
    }
  }

  // async history(msg: KernelMessage.IHistoryRequestMsg): Promise<void> {
  // }

  async inspect(msg: KernelMessage.IInspectRequestMsg): Promise<void> {
    // get code and cursor position from msg
    const code = (msg as KernelMessage.IInspectRequestMsg).content.code;
    const cursor_pos = (msg as KernelMessage.IInspectRequestMsg).content
      .cursor_pos;
    const kernelName = this.get_kernel_name_from_magic(code);

    // modify the message to remove the magic line and adjust the cursor position accordingly
    const newMsg = this._remove_kernel_magic(msg);
    const codeWithoutMagic = (newMsg.content as any).code as string;
    const magicSize = code.length - codeWithoutMagic.length;
    const newCursorPos = cursor_pos - magicSize;
    (newMsg.content as any).cursor_pos = newCursorPos;

    const make_error_reply = (errorMsg: string): void => {
      const reply_msg =
        KernelMessage.createMessage<KernelMessage.IInspectReplyMsg>({
          msgType: 'inspect_reply',
          channel: 'shell',
          session: msg.header.session,
          parentHeader: msg.header as KernelMessage.IHeader<'inspect_request'>,
          content: {
            status: 'error',
            ename: 'InvalidMagic',
            evalue: errorMsg,
            traceback: []
          }
        });
      this._sendMessage(reply_msg);
    };

    if (!kernelName) {
      make_error_reply(
        `No magic found in first line of code, expected  %%kernel <KERNEL_NAME>, but got: ${code.split('\n')[0].trim()}`
      );
      return;
    }

    const kernel = await this.getKernelByName(kernelName);
    if (!kernel) {
      make_error_reply(`Kernel ${kernelName} not found`);
      return;
    }

    // send message to kernel and wait for response
    await kernel.handleMessage(newMsg);
    return;
  }

  async commOpen(msg: KernelMessage.ICommOpenMsg): Promise<void> {
    console.log('Received comm_open', msg);
    const commId = msg.content.comm_id;
    console.log(`Received comm_open with comm_id ${commId}`);
  }

  async commClose(msg: KernelMessage.ICommCloseMsg): Promise<void> {
    console.log('Received comm_close', msg);
    const commId = msg.content.comm_id;
    console.log(`Received comm_close with comm_id ${commId}`);
    this.commIdToKernelName.delete(commId);
  }

  agglomerateAndSendCommInfoReplies(parent: KernelMessage.IMessage): void {
    const aggregatedContent: KernelMessage.ICommInfoReply = {
      comms: {},
      status: 'ok'
    };
    for (const replyContent of this._commInfoRepliesContent) {
      aggregatedContent.comms = {
        ...aggregatedContent.comms,
        ...replyContent.comms
      };
    }
    const reply_msg =
      KernelMessage.createMessage<KernelMessage.ICommInfoReplyMsg>({
        msgType: 'comm_info_reply',
        channel: 'shell',
        session: parent.header.session,
        parentHeader:
          parent.header as KernelMessage.IHeader<'comm_info_request'>,
        content: aggregatedContent
      });
    this._sendMessage(reply_msg);
  }

  async handleMessage(msg: KernelMessage.IMessage): Promise<void> {
    this._send_status(msg, 'busy');

    //this._parent = msg;

    const msgType = msg.header.msg_type;
    switch (msgType) {
      case 'kernel_info_request':
        await this._kernelInfo(msg);
        break;
      case 'execute_request':
        await this._execute(msg);
        break;
      // case 'input_reply':
      //     this.inputReply(msg.content as KernelMessage.IInputReplyMsg['content']);
      //     break;
      case 'inspect_request':
        await this.inspect(msg as KernelMessage.IInspectRequestMsg);
        break;
      case 'is_complete_request':
        await this._isComplete(msg);
        break;
      case 'complete_request':
        this._completeReplyPromise = new PromiseDelegate<void>();
        this._complete(msg);
        await this._completeReplyPromise.promise;
        break;
      // case 'history_request':
      //     await this._historyRequest(msg);
      //     break;
      case 'comm_open':
        await this.commOpen(msg as KernelMessage.ICommOpenMsg);
        break;
      case 'comm_msg':
        await this.commMsg(msg as KernelMessage.ICommMsgMsg);
        break;
      case 'comm_info_request':
        // do we have a started kernel at all
        this._commInfoReplyPromise = new PromiseDelegate<void>();
        await this.commInfo(msg as KernelMessage.ICommInfoRequestMsg);
        console.log('Waiting for comm_info_reply from all kernels');
        await Promise.race([this._commInfoReplyPromise.promise, delay(500)]);
        console.log(
          `Received comm_info_reply from #${this._commInfoRepliesContent.length} kernels, sending aggregated reply to client`
        );
        this.agglomerateAndSendCommInfoReplies(msg);

        break;
      case 'comm_close':
        await this.commClose(msg as KernelMessage.ICommCloseMsg);
        break;
      default:
        console.warn(`Unhandled message type: ${msgType}`);
        break;
    }

    this._send_status(msg, 'idle');
  }

  protected readonly kernelSpecs: IKernelSpecs;
  private _id: string;
  private _name: string;
  private _location: string;

  // map of already started kernels, keyed by kernel name
  protected startedKernels: Map<string, IKernel> = new Map();

  // map from com-id to kernel name, we use this to forward comm messages to the correct kernel
  private commIdToKernelName: Map<string, string> = new Map();

  private _sendMessage: IKernel.SendMessage;
  private _parentHeader:
    | KernelMessage.IHeader<KernelMessage.MessageType>
    | undefined = undefined;

  private _history: [number, number, string][] = [];
  private _executionCount = 0;
  private _isDisposed = false;
  private _disposed = new Signal<this, void>(this);

  // when we send a complete-request to the sub-kernel, we remove the
  // magic from the code and need to adjust the cursor position accordingly.
  // But we also need to make sure that when the sub kernel sends
  // a reply,we need to adjust the cursor position in the reply to account for the removed magic line
  private _completeReplyCurserOffset: number = 0;

  // we want only one complete request / reply at a time
  // so we store a promise we can await in the complete handler, and we resolve it when we receive the reply from the sub-kernel
  private _completeReplyPromise = new PromiseDelegate<void>();

  // the com info request is tricky since we need to aggregate the comm info from all sub-kernels and then send a single reply back to the client.
  private _commInfoReplyPromise = new PromiseDelegate<void>();
  private _commInfoRepliesContent: KernelMessage.ICommInfoReply[] = [];

  // history (for history requests)
  // we store an array of tuples of the form [execution_count, timestamp, code]
}

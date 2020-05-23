'use strict'

const errcode = require('err-code')
const { Buffer } = require('buffer')
const TimeCache = require('time-cache')
const PeerId = require('peer-id')

const pipe = require('it-pipe')
const lp = require('it-length-prefixed')
const pMap = require('p-map')

const Pubsub = require('libp2p-pubsub')

const { utils } = require('libp2p-pubsub')
const { rpc } = require('./message')

class BasicPubSub extends Pubsub {
  /**
   * @param {Object} props
   * @param {String} props.debugName log namespace
   * @param {string} props.multicodec protocol identificer to connect
   * @param {PeerId} props.peerId peer's peerId
   * @param {Object} props.registrar registrar for libp2p protocols
   * @param {function} props.registrar.handle
   * @param {function} props.registrar.register
   * @param {function} props.registrar.unregister
   * @param {Object} [props.options]
   * @param {boolean} [props.options.emitSelf] if publish should emit to self, if subscribed, defaults to false
   * @constructor
   */
  constructor ({ debugName, multicodecs, peerId, registrar, options = {} }) {
    if (!PeerId.isPeerId(peerId)) {
      throw new Error('peerId must be an instance of `peer-id`')
    }

    const _options = {
      emitSelf: false,
      ...options
    }

    super({
      debugName,
      multicodecs,
      peerId,
      registrar,
      ..._options
    })

    /**
     * A set of subscriptions
     */
    this.subscriptions = new Set()

    /**
     * Cache of seen messages
     *
     * @type {TimeCache}
     */
    this.seenCache = new TimeCache()

    /**
     * Pubsub options
     */
    this._options = _options

    /**
     * The default msgID implementation
     * @param {rpc.RPC.Message} msg the message object
     * @returns {string} message id as string
     */
    this.defaultMsgIdFn = (msg) => utils.msgId(msg.from, msg.seqno)
  }

  /**
   * Peer connected successfully with pubsub protocol.
   * @override
   * @param {PeerId} peerId peer id
   * @param {Connection} conn connection to the peer
   * @returns {Promise<void>}
   */
  async _onPeerConnected (peerId, conn) {
    await super._onPeerConnected(peerId, conn)
    const idB58Str = peerId.toB58String()
    const peer = this.peers.get(idB58Str)

    if (peer && peer.isWritable) {
      // Immediately send my own subscriptions to the newly established conn
      peer.sendSubscriptions(this.subscriptions)
    }
  }

  /**
   * Overriding the implementation of _processConnection should keep the connection and is
   * responsible for processing each RPC message received by other peers.
   * @override
   * @param {string} idB58Str peer id string in base58
   * @param {Connection} conn connection
   * @param {Peer} peer PubSub peer
   * @returns {void}
   *
   */
  async _processMessages (idB58Str, conn, peer) {
    try {
      await pipe(
        conn,
        lp.decode(),
        async (source) => {
          for await (const data of source) {
            const rpcMsgBuf = Buffer.isBuffer(data) ? data : data.slice()
            const rpcMsg = this._decodeRpc(rpcMsgBuf)

            this._processRpc(idB58Str, peer, rpcMsg)
          }
        }
      )
    } catch (err) {
      this._onPeerDisconnected(peer.id, err)
    }
  }

  /**
   * Decode a buffer into an RPC object
   *
   * Override to use an extended protocol-specific protobuf decoder
   *
   * @param {Buffer} buf
   * @returns {rpc.RPC}
   */
  _decodeRpc (buf) {
    return rpc.RPC.decode(buf)
  }

  /**
   * Handles an rpc request from a peer
   *
   * @param {String} idB58Str
   * @param {Peer} peer
   * @param {rpc.RPC} rpc
   * @returns {void}
   */
  _processRpc (idB58Str, peer, rpc) {
    this.log('rpc from', idB58Str)
    const subs = rpc.subscriptions
    const msgs = rpc.msgs

    if (subs.length) {
      // update peer subscriptions
      peer.updateSubscriptions(subs)
      subs.forEach((subOpt) => this._processRpcSubOpt(peer, subOpt))
      this.emit('pubsub:subscription-change', peer.id, peer.topics, subs)
    }

    if (msgs.length) {
      msgs.forEach(async message => {
        const msg = utils.normalizeInRpcMessage(message)
        const msgID = this.getMsgId(msg)

        // Ignore if we've already seen the message
        if (this.seenCache.has(msgID)) {
          return
        }

        this.seenCache.put(msgID)

        // Ensure the message is valid before processing it
        let isValid
        let error

        try {
          isValid = await this.validate(message)
        } catch (err) {
          error = err
        }

        if (error || !isValid) {
          this.log('Message could not be validated, dropping it. isValid=%s', isValid, error)
          return
        }

        this._processRpcMessage(peer, msg)
      })
    }
  }

  /**
   * Handles an subscription change from a peer
   *
   * @param {Peer} peer
   * @param {rpc.RPC.SubOpt} subOpt
   */
  _processRpcSubOpt (peer, subOpt) {
    const t = subOpt.topicID

    let topicSet = this.topics.get(t)
    if (!topicSet) {
      topicSet = new Set()
      this.topics.set(t, topicSet)
    }

    if (subOpt.subscribe) {
      // subscribe peer to new topic
      topicSet.add(peer)
    } else {
      // unsubscribe from existing topic
      topicSet.delete(peer)
    }
  }

  /**
   * Handles an message from a peer
   *
   * @param {Peer} peer
   * @param {rpc.RPC.Message} msg
   */
  _processRpcMessage (peer, msg) {
    if (this.peerId.toB58String() === msg.from && !this._options.emitSelf) {
      return
    }

    // Emit to self
    this._emitMessage(msg.topicIDs, msg)
  }

  _emitMessage (topics, message) {
    topics.forEach((topic) => {
      if (this.subscriptions.has(topic)) {
        this.emit(topic, message)
      }
    })
  }

  /**
   * Unmounts the protocol and shuts down every connection
   * @override
   * @returns {void}
   */
  async stop () {
    await super.stop()

    this.subscriptions = new Set()
  }

  /**
   * Subscribes to topics
   * @override
   * @param {Array<string>|string} topics
   * @returns {void}
   */
  subscribe (topics) {
    if (!this.started) {
      throw new Error('Pubsub has not started')
    }

    topics = utils.ensureArray(topics)

    const newTopics = topics.filter((topic) => !this.subscriptions.has(topic))
    if (newTopics.length === 0) {
      return
    }

    // set subscriptions
    newTopics.forEach((topic) => {
      this.subscriptions.add(topic)
    })

    // Broadcast SUBSCRIBE to all peers
    this.peers.forEach((peer) => sendSubscriptionsOnceReady(peer))

    // make sure that Gossipsub is already mounted
    function sendSubscriptionsOnceReady (peer) {
      if (peer && peer.isWritable) {
        return peer.sendSubscriptions(topics)
      }
      const onConnection = () => {
        peer.removeListener('connection', onConnection)
        sendSubscriptionsOnceReady(peer)
      }
      peer.on('connection', onConnection)
      peer.once('close', () => peer.removeListener('connection', onConnection))
    }

    this.join(newTopics)
  }

  join (topics) {
    throw errcode(new Error('join must be implemented by the subclass'), 'ERR_NOT_IMPLEMENTED')
  }

  /**
   * Leaves a topic
   * @override
   * @param {Array<string>|string} topics
   * @returns {void}
   */
  unsubscribe (topics) {
    if (!this.started) {
      throw new Error('Pubsub has not started')
    }

    topics = utils.ensureArray(topics)

    const unTopics = topics.filter((topic) => this.subscriptions.has(topic))
    if (!unTopics.length) {
      return
    }

    // delete subscriptions
    unTopics.forEach((topic) => {
      this.subscriptions.delete(topic)
    })

    // Broadcast UNSUBSCRIBE to all peers ready
    this.peers.forEach((peer) => sendUnsubscriptionsOnceReady(peer))

    // make sure that Gossipsub is already mounted
    function sendUnsubscriptionsOnceReady (peer) {
      if (peer && peer.isWritable) {
        return peer.sendUnsubscriptions(topics)
      }
      const onConnection = () => {
        peer.removeListener('connection', onConnection)
        sendUnsubscriptionsOnceReady(peer)
      }
      peer.on('connection', onConnection)
      peer.once('close', () => peer.removeListener('connection', onConnection))
    }

    this.leave(unTopics)
  }

  leave (topics) {
    throw errcode(new Error('leave must be implemented by the subclass'), 'ERR_NOT_IMPLEMENTED')
  }

  /**
   * Publishes messages to all subscribed peers
   * @override
   * @param {Array<string>|string} topics
   * @param {Array<any>|any} messages
   * @returns {void}
   */
  async publish (topics, messages) {
    if (!this.started) {
      throw new Error('Pubsub has not started')
    }

    this.log('publish', topics, messages)

    topics = utils.ensureArray(topics)
    messages = utils.ensureArray(messages)

    const from = this.peerId.toB58String()

    const buildMessage = (msg, cb) => {
      const seqno = utils.randomSeqno()
      const msgObj = {
        from: from,
        data: msg,
        seqno: seqno,
        topicIDs: topics
      }
      // put in seen cache
      this.seenCache.put(msgObj.seqno)

      // Emit to self if I'm interested and emitSelf enabled
      this._options.emitSelf && this._emitMessages(topics, [msgObj])

      return this._buildMessage(msgObj)
    }
    const msgObjects = await pMap(messages, buildMessage)

    // send to all the other peers
    this._publish(utils.normalizeOutRpcMessages(msgObjects))
  }

  /**
   * Get the list of topics which the peer is subscribed to.
   * @override
   * @returns {Array<String>}
   */
  getTopics () {
    if (!this.started) {
      throw new Error('Pubsub is not started')
    }

    return Array.from(this.subscriptions)
  }

  /**
   * Child class can override this.
   * @param {rpc.RPC.Message} msg the message object
   * @returns {string} message id as string
   */
  getMsgId (msg) {
    return this.defaultMsgIdFn(msg)
  }

  _emitMessages (topics, messages) {
    topics.forEach((topic) => {
      if (!this.subscriptions.has(topic)) {
        return
      }

      messages.forEach((message) => {
        this.emit(topic, message)
      })
    })
  }

  _publish (rpcs) {
    throw errcode(new Error('_publish must be implemented by the subclass'), 'ERR_NOT_IMPLEMENTED')
  }
}

module.exports = BasicPubSub

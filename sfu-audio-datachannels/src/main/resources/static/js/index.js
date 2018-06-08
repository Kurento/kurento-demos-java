/*
 * Copyright 2018 Kurento (https://www.kurento.org)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const ws = new WebSocket('wss://' + location.host + '/sfu-audio-datachannels');

function StateVars(tag, dataTag, peer, pc) {
  this.tag = tag || null;  // <audio> or <video> tag
  this.dataTag = dataTag || null;  // <textarea> tag
  this.peer = peer || null;  // kurentoUtils.WebRtcPeer
  this.pc = pc || null;  // RTCPeerConnection
}

const talker = new StateVars();
const listener1 = new StateVars();
const listener2 = new StateVars();

const peers = new Map();  // Map<(String)WebRtcEndpoint.Id, (Object)WebRtcPeer>

// UI
let uiState = null;
const UI_IDLE = 0;
const UI_STARTING = 1;
const UI_STARTED = 2;

window.onload = function()
{
  console = new Console();
  console.log("Page loaded");
  uiSetState(UI_IDLE);

  talker.tag = document.getElementById('uiTalkerAudio');
  talker.dataTag = document.getElementById('uiTalkerDataTxt');
  listener1.tag = document.getElementById('uiListener1Audio');
  listener1.dataTag = document.getElementById('uiListener1DataTxt');
  listener2.tag = document.getElementById('uiListener2Audio');
  listener2.dataTag = document.getElementById('uiListener2DataTxt');
}

window.onbeforeunload = function()
{
  console.log("Page unload - Close WebSocket");
  ws.close();
}

function explainUserMediaError(err)
{
  const n = err.name;
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') {
    return "Missing webcam for required tracks";
  }
  else if (n === 'NotReadableError' || n === 'TrackStartError') {
    return "Webcam is already in use";
  }
  else if (n === 'OverconstrainedError' || n === 'ConstraintNotSatisfiedError') {
    return "Webcam doesn't provide required tracks";
  }
  else if (n === 'NotAllowedError' || n === 'PermissionDeniedError') {
    return "Webcam permission has been denied by the user";
  }
  else if (n === 'TypeError') {
    return "No media tracks have been requested";
  }
  else {
    return "Unknown error: " + err;
  }
}

function sendError(message)
{
  console.error(message);

  sendMessage({
    id: 'ERROR',
    message: message,
  });
}

function sendMessage(message)
{
  if (ws.readyState !== ws.OPEN) {
    console.warn("[sendMessage] Skip, WebSocket session isn't open");
    return;
  }

  const jsonMessage = JSON.stringify(message);
  console.log("[sendMessage] message: " + jsonMessage);
  ws.send(jsonMessage);
}

function makePeer(sdpOffer, webRtcEpId)
{
  console.log("[makePeer] Make WebRtcPeerSendonly, webRtcEpId: " + webRtcEpId);

  const options = {
    localVideo: talker.tag,
    remoteVideo: null,
    mediaConstraints: { audio: true, video: false },
    onicecandidate: (candidate) => sendMessage({
      id: 'ADD_ICE_CANDIDATE',
      webRtcEpId: webRtcEpId,
      candidate: candidate,
    }),
    onnegotiationneeded: (ev) => console.log("[talker.WebRtcPeer.onnegotiationneeded] NOOP, webRtcEpId: "
        + webRtcEpId),
    dataChannels: true,
    dataChannelConfig: {
      onopen: (ev) =>
        console.log("[talker.WebRtcPeer.DataChannel.onopen] NOOP"),
      onclose: (ev) =>
        console.log("[talker.WebRtcPeer.DataChannel.onclose] NOOP"),
      onmessage: (msgEv) => {
        // https://developer.mozilla.org/en-US/docs/Web/API/MessageEvent
        console.log("[talker.WebRtcPeer.DataChannel.onmessage] Message: "
            + msgEv.data);
        talker.dataTag.value = talker.dataTag.value + "\n" + msgEv.data;
      },
      onerror: (errEv) =>
        // https://developer.mozilla.org/en-US/docs/Web/API/ErrorEvent
        console.log("[talker.WebRtcPeer.DataChannel.onerror] Error: "
            + errEv.message),
    },
  };

  talker.peer = new kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options,
      function(err)
  {
    if (err) {
      sendError("[talker.WebRtcPeer] Error: " + explainUserMediaError(err));
      stop();
      return;
    }

    console.log("[talker.WebRtcPeer] Created");

    peers.set(webRtcEpId, talker.peer);
    talker.pc = talker.peer.peerConnection;

    sendMessage({
      id: 'WEBRTCPEER_READY',
      webRtcEpId: webRtcEpId,
    });

    console.log("[talker.WebRtcPeer] Process SDP Offer");
    talker.peer.processOffer(sdpOffer, (err, sdpAnswer) => {
      if (err) {
        sendError("[talker.WebRtcPeer.processOffer] Error: " + err);
        stop();
        return;
      }

      sendMessage({
        id: 'PROCESS_SDP_ANSWER',
        webRtcEpId: webRtcEpId,
        sdpAnswer: sdpAnswer,
      });

      console.log("[talker.WebRtcPeer.processOffer] Done!");
      uiSetState(UI_STARTED);
    });
  });
}



/******************************************************************************/
/* WebSocket signaling                                                        */
/******************************************************************************/

ws.onmessage = function(message)
{
  const jsonMessage = JSON.parse(message.data);
  console.log("[onmessage] Received message: " + message.data);

  switch (jsonMessage.id) {
    case 'MAKE_TALKER':
      handleMakeTalker(jsonMessage);
      break;
    case 'MAKE_LISTENER':
      handleMakeListener(jsonMessage);
      break;
    case 'ADD_ICE_CANDIDATE':
      handleAddIceCandidate(jsonMessage);
      break;
    case 'ERROR':
      handleError(jsonMessage);
      break;
    default:
      console.warn("[onmessage] Invalid message, id: " + jsonMessage.id);
      break;
  }
}

// MAKE_TALKER -----------------------------------------------------------------

function handleMakeTalker(jsonMessage)
{
  makePeer(jsonMessage.sdpOffer, jsonMessage.webRtcEpId);
}

// MAKE_LISTENER ---------------------------------------------------------------

function handleMakeListener(jsonMessage)
{
  const isFirst = (listener1.peer === null);
  const listener = (isFirst ? listener1 : listener2);

  console.log("[handleMakeListener] Make WebRtcPeerRecvonly");

  const webRtcEpId = jsonMessage.webRtcEpId;

  const options = {
    localVideo: null,
    remoteVideo: listener.tag,
    mediaConstraints: { audio: true, video: false },
    onicecandidate: (candidate) => sendMessage({
      id: 'ADD_ICE_CANDIDATE',
      webRtcEpId: webRtcEpId,
      candidate: candidate,
    }),
    onnegotiationneeded: (ev) => console.log("[listener.WebRtcPeer.onnegotiationneeded] NOOP, webRtcEpId: "
        + webRtcEpId),
    dataChannels: true,
    dataChannelConfig: {
      onopen: (ev) =>
        console.log("[listener.WebRtcPeer.DataChannel.onopen] NOOP"),
      onclose: (ev) =>
        console.log("[listener.WebRtcPeer.DataChannel.onclose] NOOP"),
      onmessage: (msgEv) => {
        // https://developer.mozilla.org/en-US/docs/Web/API/MessageEvent
        console.log("[listener.WebRtcPeer.DataChannel.onmessage] Message: "
            + msgEv.data);
        listener.dataTag.value = listener.dataTag.value + "\n" + msgEv.data;
      },
      onerror: (errEv) =>
        // https://developer.mozilla.org/en-US/docs/Web/API/ErrorEvent
        console.log("[listener.WebRtcPeer.DataChannel.onerror] Error: "
            + errEv.message),
    },
  };

  listener.peer = new kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options,
      function(err)
  {
    if (err) {
      sendError("[listener.WebRtcPeer] Error: "
          + explainUserMediaError(err));
      stop();
      return;
    }

    console.log("[listener.WebRtcPeer] Created");

    peers.set(webRtcEpId, listener.peer);
    listener.pc = listener.peer.peerConnection;
    listener.pc.ontrack = (trackEv) => {
      if (trackEv.track.kind === 'audio') {
        console.log("[listener.WebRtcPeer.ontrack] Set incoming stream");
        listener.tag.srcObject = trackEv.streams[0];
      }
    };

    sendMessage({
      id: 'WEBRTCPEER_READY',
      webRtcEpId: webRtcEpId,
    });

    console.log("[listener.WebRtcPeer] Process SDP Offer");
    listener.peer.processOffer(jsonMessage.sdpOffer, (err, sdpAnswer) => {
      if (err) {
        sendError("[listener.WebRtcPeer.processOffer] Error: "
            + err);
        stop();
        return;
      }

      sendMessage({
        id: 'PROCESS_SDP_ANSWER',
        webRtcEpId: webRtcEpId,
        sdpAnswer: sdpAnswer,
      });

      console.log("[listener.WebRtcPeer.processOffer] Done!");
    });
  });
}

// ADD_ICE_CANDIDATE -----------------------------------------------------------

function handleAddIceCandidate(jsonMessage)
{
  const webRtcEpId = jsonMessage.webRtcEpId;
  if (!peers.has(webRtcEpId)) {
    console.warn("[handleAddIceCandidate] Skip, unknown endpoint, id: "
        + webRtcEpId);
    return;
  }

  const peer = peers.get(webRtcEpId);
  peer.addIceCandidate(jsonMessage.candidate, (err) => {
    if (err) {
      console.error("[handleAddIceCandidate] Error: " + err);
      return;
    }
  });
}

// STOP ------------------------------------------------------------------------

function stop()
{
  if (uiState == UI_IDLE) {
    console.log("[stop] Skip, already stopped");
    return;
  }

  console.warn("[stop] NOT IMPLEMENTED YET");

  uiSetState(UI_IDLE);

  sendMessage({
    id: 'STOP',
  });
}

// ERROR -----------------------------------------------------------------------

function handleError(jsonMessage)
{
  const errMessage = jsonMessage.message;
  console.error("Kurento error: " + errMessage);

  console.log("Assume that the other side stops after an error...");
  stop();
}



/******************************************************************************/
/* UI actions & state                                                         */
/******************************************************************************/

// Start -----------------------------------------------------------------------

function uiStart()
{
  console.log("[start]");
  uiSetState(UI_STARTING);

  sendMessage({
    id: 'START',
  });
}

// Stop ------------------------------------------------------------------------

function uiStop()
{
  stop();
}

// Send ------------------------------------------------------------------------

function uiSend()
{
  const message = talker.dataTag.value;
  console.log("[send] message: " + message);

  talker.peer.send(message);
  talker.dataTag.value = "";
}

// State handling --------------------------------------------------------------

function uiSetState(newState)
{
  switch (newState) {
    case UI_IDLE:
      uiEnableElement('#uiStartBtn', 'uiStart()');
      uiDisableElement('#uiStopBtn');
      uiDisableElement('#uiSendBtn');
      break;
    case UI_STARTING:
      uiDisableElement('#uiStartBtn');
      uiDisableElement('#uiStopBtn');
      uiDisableElement('#uiSendBtn');
      break;
    case UI_STARTED:
      uiDisableElement('#uiStartBtn');
      uiEnableElement('#uiStopBtn', 'uiStop()');
      uiEnableElement('#uiSendBtn', 'uiSend()');
      break;
    default:
      console.warn("[setState] Skip, invalid state: " + newState);
      return;
  }
  uiState = newState;
}

function uiEnableElement(id, onclickHandler)
{
  $(id).attr('disabled', false);
  if (onclickHandler) {
    $(id).attr('onclick', onclickHandler);
  }
}

function uiDisableElement(id)
{
  $(id).attr('disabled', true);
  $(id).removeAttr('onclick');
}

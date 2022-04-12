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

const ws = new WebSocket('wss://' + location.host + '/composite-datachannels');

let peer;  // kurentoUtils.WebRtcPeer

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
  console.log("[makePeer] Make WebRtcPeerSendrecv, webRtcEpId: " + webRtcEpId);

  const options = {
    localVideo: uiLocalVideo,
    remoteVideo: uiRemoteVideo,
    mediaConstraints: { audio: true, video: true },
    onicecandidate: (candidate) => sendMessage({
      id: 'ADD_ICE_CANDIDATE',
      webRtcEpId: webRtcEpId,
      candidate: candidate,
    }),
    onnegotiationneeded: (ev) => console.log("[WebRtcPeer.onnegotiationneeded] NOOP, webRtcEpId: "
        + webRtcEpId),
    dataChannels: true,
    dataChannelConfig: {
      onopen: (ev) =>
        console.log("[WebRtcPeer.DataChannel.onopen] NOOP"),
      onclose: (ev) =>
        console.log("[WebRtcPeer.DataChannel.onclose] NOOP"),
      onmessage: (msgEv) => {
        // https://developer.mozilla.org/en-US/docs/Web/API/MessageEvent
        console.log("[WebRtcPeer.DataChannel.onmessage] Message: "
            + msgEv.data);
        uiRemoteDataTxt.value = uiRemoteDataTxt.value + "\n" + msgEv.data;
      },
      onerror: (errEv) =>
        // https://developer.mozilla.org/en-US/docs/Web/API/ErrorEvent
        console.log("[WebRtcPeer.DataChannel.onerror] Error: " + errEv.message),
    },
  };

  peer = new kurentoUtils.WebRtcPeer.WebRtcPeerSendrecv(options,
      function(err)
  {
    if (err) {
      sendError("[WebRtcPeer] Error: " + explainUserMediaError(err));
      stop();
      return;
    }

    console.log("[WebRtcPeer] Created");

    sendMessage({
      id: 'WEBRTCPEER_READY',
      webRtcEpId: webRtcEpId,
    });

    console.log("[WebRtcPeer] Process SDP Offer");
    peer.processOffer(sdpOffer, (err, sdpAnswer) => {
      if (err) {
        sendError("[WebRtcPeer.processOffer] Error: " + err);
        stop();
        return;
      }

      sendMessage({
        id: 'PROCESS_SDP_ANSWER',
        webRtcEpId: webRtcEpId,
        sdpAnswer: sdpAnswer,
      });

      console.log("[WebRtcPeer.processOffer] Done!");
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
    case 'MAKE_PEER':
      handleMakePeer(jsonMessage);
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

// MAKE_PEER -----------------------------------------------------------------

function handleMakePeer(jsonMessage)
{
  makePeer(jsonMessage.sdpOffer, jsonMessage.webRtcEpId);
}

// ADD_ICE_CANDIDATE -----------------------------------------------------------

function handleAddIceCandidate(jsonMessage)
{
  if (peer == null) {
    console.warn("[handleAddIceCandidate] Skip, no WebRTC Peer");
    return;
  }

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

  uiSetState(UI_IDLE);
  hideSpinner(uiLocalVideo, uiRemoteVideo);

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
  showSpinner(uiLocalVideo, uiRemoteVideo);

  sendMessage({
    id: 'START',
  });
}

// Stop ------------------------------------------------------------------------

function uiStop()
{
  stop();
}

// Debug -----------------------------------------------------------------------

function uiDebug()
{
  sendMessage({
    id: 'DEBUG',
  });
}

// Send ------------------------------------------------------------------------

function uiSend()
{
  const message = uiLocalDataTxt.value;
  console.log("[send] message: " + message);

  peer.send(message);
  uiLocalDataTxt.value = "";
}

// State handling --------------------------------------------------------------

function uiSetState(newState)
{
  switch (newState) {
    case UI_IDLE:
      uiEnableElement('#uiStartBtn', 'uiStart()');
      uiDisableElement('#uiStopBtn');
      uiDisableElement('#uiDebugBtn');
      uiDisableElement('#uiSendBtn');
      break;
    case UI_STARTING:
      uiDisableElement('#uiStartBtn');
      uiDisableElement('#uiStopBtn');
      uiDisableElement('#uiDebugBtn');
      uiDisableElement('#uiSendBtn');
      break;
    case UI_STARTED:
      uiDisableElement('#uiStartBtn');
      uiEnableElement('#uiStopBtn', 'uiStop()');
      uiEnableElement('#uiDebugBtn', 'uiDebug()');
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

function showSpinner()
{
  for (let i = 0; i < arguments.length; i++) {
    arguments[i].poster = './img/transparent-1px.png';
    arguments[i].style.background = "center transparent url('./img/spinner.gif') no-repeat";
  }
}

function hideSpinner()
{
  for (let i = 0; i < arguments.length; i++) {
    arguments[i].src = '';
    arguments[i].poster = './img/webrtc.png';
    arguments[i].style.background = '';
  }
}

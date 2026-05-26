// ==UserScript==
// @name Thugware-pro-zoom
// @description we do a little thugging
// @version 1.0.0
// @author marcusvane
// @homepage https://github.com/marcusvane/Thugware-pro-zoom
// @supportURL https://github.com/marcusvane/Thugware-pro-zoom
// @match *://app.zoom.us/*
// @grant none
// ==/UserScript==

(() => {
    // Global variables
    var originalPublishCursor = null;
    var originalSendViewport = null;
    var followPluginDisabled = false;
    
    // ==================== UTILITY FUNCTIONS ====================
    
    // Disable whiteboard follow plugin
    function toggleWhiteboardFollow() {
        followPluginDisabled = !followPluginDisabled;
        let whiteboard = this.hooks.whiteboard;
        let followPlugin = whiteboard.plugins.get("followPlugin");
        
        // Override publishCursor function if not already done
        if (originalPublishCursor == null) {
            originalPublishCursor = whiteboard.publishCursor;
            whiteboard.publishCursor = function() {
                if (!followPluginDisabled) return originalPublishCursor.apply(whiteboard, arguments);
            };
        }
        
        // Override sendViewport function if not already done
        if (originalSendViewport == null) {
            originalSendViewport = followPlugin.sendViewport;
            followPlugin.sendViewport = function() {
                if (!followPluginDisabled) return originalSendViewport.apply(followPlugin, arguments);
            };
        }
    }
    
    // Auto rejoin on kick
    function toggleAutoRejoin() {
        let self = this;
        
        if (toggleAutoRejoin.interval) {
            clearInterval(toggleAutoRejoin.interval);
            toggleAutoRejoin.interval = undefined;
            return;
        }
        
        toggleAutoRejoin.interval = setInterval(function() {
            // Check for exit/leave buttons (indicating being kicked)
            const exitButtons = self.scope.document.getElementsByClassName("zm-btn zm-btn-legacy zm-btn--primary");
            const leaveButtons = self.scope.document.getElementsByClassName("zm-btn zm-btn-legacy zm-btn--primary zm-btn__outline--blue");
            
            if ((exitButtons[0]?.innerText == "Exit") || (leaveButtons[0]?.innerText === "Leave")) {
                // Clear all storage and reload
                localStorage.clear();
                sessionStorage.clear();
                self.scope.localStorage.clear();
                self.scope.sessionStorage.clear();
                self.scope.location.reload();
                self.hooks.recache();
            }
        }, 500);
    }
    
    // Auto unmute and enable video
    function toggleAutoMedia() {
        let self = this;
        
        if (toggleAutoMedia.interval) {
            clearInterval(toggleAutoMedia.interval);
            toggleAutoMedia.interval = undefined;
            return;
        }
        
        toggleAutoMedia.interval = setInterval(function() {
            // Unmute and enable video for main user
            if (self.hooks.state.meeting.currentUser.muted) {
                self.actions.toggleMute(false);
            }
            if (!self.hooks.state.meeting.currentUser.bVideoOn) {
                self.actions.toggleVideo(true);
            }
            
            // Apply to all bots
            if (window.bots) {
                window.bots.forEach(bot => {
                    if (bot?.loaded) {
                        if (bot.hooks.state.meeting.currentUser.muted) {
                            bot.actions.toggleMute(false);
                        }
                        if (!bot.hooks.state.meeting.currentUser.bVideoOn) {
                            bot.actions.toggleVideo(true);
                        }
                    }
                });
            }
        }, window.spammerSpeed);
    }
    
    // ==================== ACTIONS ====================
    
    function createActions(hooks) {
        return {
            // Change display name
            changeUsername(name) {
                hooks.dispatchSocketMessage({
                    evt: hooks.packets.WS_CONF_RENAME_REQ,
                    body: {
                        id: hooks.state.meeting.currentUser.userId,
                        dn2: btoa(name),
                        olddn2: btoa(hooks.state.meeting.currentUser.displayName)
                    }
                });
            },
            
            // Toggle microphone
            toggleMute(state) {
                if (state == null) state = !hooks.state.meeting.currentUser.muted;
                
                hooks.dispatchSocketMessage({
                    evt: hooks.actionPackets.USER_NODE_AUDIO_STATUS_LIST,
                    body: {
                        add: null,
                        remove: null,
                        update: [{
                            id: hooks.state.meeting.currentUser.userId,
                            muted: state
                        }]
                    }
                });
                
                hooks.dispatchSocketMessage({
                    evt: hooks.packets.WS_AUDIO_MUTE_REQ,
                    body: {
                        id: hooks.state.meeting.currentUser.userId,
                        bMute: state
                    }
                });
            },
            
            // Toggle hand raise
            toggleHand(state) {
                if (state == null) state = !hooks.state.meeting.currentUser.bRaiseHand;
                
                hooks.dispatchSocketMessage({
                    evt: hooks.packets.WS_CONF_RAISE_LOWER_HAND_REQ,
                    body: {
                        id: hooks.state.meeting.currentUser.userId,
                        bOn: state
                    }
                });
            },
            
            // Toggle video
            toggleVideo(state) {
                if (state == null) state = !hooks.state.meeting.currentUser.bVideoOn;
                
                if (state) {
                    // Start video
                    hooks.findModuleFn("user start capture video")()(hooks.store.dispatch, hooks.store.getState);
                } else {
                    // Stop video
                    hooks.dispatchSocketMessage({
                        evt: hooks.packets.WS_VIDEO_MUTE_VIDEO_REQ,
                        body: {
                            id: hooks.state.meeting.currentUser.userId,
                            bOn: !state
                        }
                    });
                }
            },
            
            // Send reaction emoji
            sendReaction(emoji) {
                hooks.dispatchSocketMessage({
                    evt: hooks.packets.WS_CONF_SEND_REACTION_REQ,
                    body: {
                        uNodeID: hooks.state.meeting.currentUser.userId,
                        strEmojiContent: emoji
                    }
                });
            },
            
            // Request AI companion
            requestAI() {
                hooks.dispatchSocketMessage({
                    evt: hooks.packets.WS_CONF_QUERY_OP_REQ,
                    body: { type: "reqAICStart" }
                });
            },
            
            // Request screenshare control
            requestScreenshare(userId) {
                hooks.dispatchSocketMessage({
                    evt: hooks.packets.WS_SHARING_REMOTE_CONTROL_REQ,
                    body: { id: userId, bOn: true }
                });
            },
            
            // Send chat message
            sendMessage(text, mention = [], style = [], recipient) {
                hooks.sendChatMessage({ text, styleItems: style, mention }, recipient)(hooks.store.dispatch, hooks.store.getState);
            }
        };
    }
    
    // ==================== HOOKS ====================
    
    function createHooks(scope) {
        let cache = {};
        
        return {
            // Get webpack require
            get wpRequire() {
                if (cache.wpRequire) return cache.wpRequire;
                
                // Try to find existing webpack require
                let req = scope?.webpackChunkwebclient.find(m => m[2]);
                if (!req) {
                    // Create new one if not found
                    cache.wpRequire = scope.webpackChunkwebclient?.push([[Symbol()], {}, m => m]);
                } else {
                    cache.wpRequire = req;
                }
                
                return cache.wpRequire;
            },
            
            // Get packet receiver
            get receivePacket() {
                return cache.receivePacket ??= Thugware.hooks.findModuleFn(".notifyCommandSocoket(");
            },
            
            // Get Redux store
            get store() {
                return Object.values(scope.document.getElementById("root"))[0].memoizedState.element.props.store;
            },
            
            // Get whiteboard instance
            get whiteboard() {
                return Object.values(scope.document.getElementById("ui-components"))[0].child.pendingProps.children.props.wb;
            },
            
            // Get current state
            get state() {
                return this.store.getState();
            },
            
            // Find module by string content
            findModule(str) {
                return this.wpRequire(Object.keys(this.wpRequire.m)[
                    Object.values(this.wpRequire.m).findIndex(m => m.toString().includes(str))
                ]);
            },
            
            // Find specific function in module
            findModuleFn(str) {
                return Object.values(this.findModule(str)).find(f => f.toString().includes(str));
            },
            
            // Get packet name
            getPacketName(packet) {
                let idx = Object.values(this.packets).findIndex(p => p == packet);
                return Object.keys(this.packets)[idx];
            },
            
            // Send WebSocket message
            get sendSocketMessage() {
                return cache.sendSocketMessage ??= this.findModuleFn(".WS_AUDIO_DIALOUT_REQ:");
            },
            
            // Dispatch action to store
            dispatchSocketMessage(data) {
                return this.store.dispatch(this.sendSocketMessage(data));
            },
            
            // Send chat message function
            get sendChatMessage() {
                return cache.sendChatMessage ??= this.findModuleFn("mention,localXmppMsgId");
            },
            
            // Get packet definitions
            get packets() {
                return cache.packets ??= this.findModule("WS_CONF_RENAME_REQ");
            },
            
            // Get action packet definitions
            get actionPackets() {
                return cache.actionPackets ??= this.findModule("USER_NODE_AUDIO_STATUS_LIST:()");
            },
            
            // Get toast notification function
            get showToast() {
                return cache.showToast ??= Object.values(this.findModule("AliveToast.uniqueToast"))[0].toast;
            },
            
            // Get easy store
            get easyStore() {
                return cache.easyStore ??= Object.values(this.findModule("easy
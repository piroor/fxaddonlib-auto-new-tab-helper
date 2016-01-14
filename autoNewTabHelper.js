/**
 * @fileOverview Helper Library for Automatic New Tab Features
 * @author       YUKI "Piro" Hiroshi
 * @version      11
 *
 * @license
 *   The MIT License, Copyright (c) 2009-2015 YUKI "Piro" Hiroshi.
 *   http://github.com/piroor/fxaddonlib-auto-new-tab-helper/blob/master/license.txt
 * @url http://github.com/piroor/fxaddonlib-auto-new-tab-helper
 */
 
var EXPORTED_SYMBOLS = ['autoNewTabHelper'];
 
const Cc = Components.classes;
const Ci = Components.interfaces;
	
var autoNewTabHelper = { 
	kID : 'checknewtab-id',
	kNEW_TAB_READY: 'data-moz-open-newtab-ready',
	
	get _IOService() { 
		if (!this.__IOService) {
			this.__IOService = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService);
		}
		return this.__IOService;
	},
	__IOService : null,

	get _WindowMediator() {
		if (!this.__WindowMediator) {
			this.__WindowMediator = Cc['@mozilla.org/appshell/window-mediator;1'].getService(Ci.nsIWindowMediator);
		}
		return this.__WindowMediator;
	},
	__WindowMediator : null,

	get _EffectiveTLD()
	{
		if (!('__EffectiveTLD' in this)) {
			this.__EffectiveTLD = 'nsIEffectiveTLDService' in Ci ?
				Cc['@mozilla.org/network/effective-tld-service;1'].getService(Ci.nsIEffectiveTLDService) :
				null ;
		}
		return this.__EffectiveTLD;
	},
//	__EffectiveTLD : null,

	get _URIFixup()
	{
		if (!('__URIFixup' in this)) {
			this.__URIFixup = Cc['@mozilla.org/docshell/urifixup;1'].getService(Ci.nsIURIFixup);
		}
		return this.__URIFixup;
	},

	get _Task()
	{
		if (!this.__Task) {
			let TaskNS = {};
			Components.utils.import('resource://gre/modules/Task.jsm', TaskNS);
			this.__Task = TaskNS.Task;
		}
		return this.__Task;
	},
 
/* utilities */ 
	
	get browserWindow() 
	{
		return this._WindowMediator.getMostRecentWindow('navigator:browser');
	},
 
	get browser() 
	{
		var w = this.browserWindow;
		return !w ? null :
			'SplitBrowser' in w ? w.SplitBrowser.activeBrowser :
			w.gBrowser ;
	},
 
// tabbrowser 
	
	getTabFromFrame : function OLITUtils_getTabFromFrame(aFrame, aTabBrowser) 
	{
		var b = aTabBrowser || this.browser;
		var top = aFrame.top;
		var tabs = Array.slice(b.mTabContainer.childNodes) ;
		for each (var tab in tabs)
		{
			if (tab.linkedBrowser.contentWindow == top)
				return tab;
		}
		return null;
	},
 
	getTabBrowserFromChild : function OLITUtils_getTabBrowserFromChild(aTabBrowserChild) 
	{
		if (!aTabBrowserChild)
			return null;

		if (aTabBrowserChild.localName == 'tabbrowser') // itself
			return aTabBrowserChild;

		if (aTabBrowserChild.tabbrowser) // tabs, Firefox 4.0 or later
			return aTabBrowserChild.tabbrowser;

		if (aTabBrowserChild.id == 'TabsToolbar') // tabs toolbar, Firefox 4.0 or later
			return aTabBrowserChild.getElementsByTagName('tabs')[0].tabbrowser;

		var b = aTabBrowserChild.ownerDocument.evaluate(
				'ancestor::*[local-name()="tabbrowser"] | '+
				'ancestor::*[local-name()="tabs" and @tabbrowser] |'+
				'ancestor::*[local-name()="toolbar" and @id="TabsToolbar"]/descendant::*[local-name()="tabs"]',
				aTabBrowserChild,
				null,
				Ci.nsIDOMXPathResult.FIRST_ORDERED_NODE_TYPE,
				null
			).singleNodeValue;
		return (b && b.tabbrowser) || b;
	},
 
	getTabBrowserFromFrame : function OLITUtils_getTabBrowserFromFrame(aFrame) 
	{
		var w = this.browserWindow;
		return !w ? null :
			('SplitBrowser' in w) ? this.getTabBrowserFromChild(w.SplitBrowser.getSubBrowserAndBrowserFromFrame(aFrame.top).browser) :
			this.browser ;
	},
 
	getFrameFromTabBrowserElements : function OLITUtils_getFrameFromTabBrowserElements(aFrameOrTabBrowser) 
	{
		var frame = aFrameOrTabBrowser;
		if (frame == '[object XULElement]') {
			if (frame.localName == 'tab') {
				frame = frame.linkedBrowser.contentWindow;
			}
			else if (frame.localName == 'browser') {
				frame = frame.contentWindow;
			}
			else {
				frame = this.getTabBrowserFromChild(frame);
				if (!frame) return null;
				frame = frame.contentWindow;
			}
		}
		if (!frame)
			frame = this.browser.contentWindow;

		return frame;
	},
   
/* get tab(s) */ 
	
	_getTabId : function OLITUtils_getTabId(aTab) 
	{
		if (!aTab)
			return '';
		var id = aTab.getAttribute(this.kID);
		if (!id) {
			id = 'tab-<'+Date.now()+'-'+parseInt(Math.random() * 65000)+'>';
			aTab.setAttribute(this.kID, id);
		}
		return id;
	},
 
	_getTabById : function OLITUtils_getTabById(aId, aTabBrowserChildren) 
	{
		if (!aId) return null;
		var b = this.getTabBrowserFromChild(aTabBrowserChildren) || this.browser;
		return b.ownerDocument.evaluate(
			'descendant::*[local-name()="tab" and @'+this.kID+' = "'+aId+'"]',
			b.mTabContainer,
			null,
			Ci.nsIDOMXPathResult.FIRST_ORDERED_NODE_TYPE,
			null
		).singleNodeValue;
	},
 
	_getNextVisibleTab : function OLITUtils_getNextVisibleTab(aTab) 
	{
		if (!aTab) return null;
		var next = aTab;
		do {
			next = next.nextSibling;
		}
		while (next && next.boxObject.width && next.boxObject.height);
		return next;
	},
  
	checkReadyToOpenNewTab : function OLITUtils_checkReadyToOpenNewTab(aInfo) 
	{
/*
	挙動の説明

	・現在のサイトと異なるサイトを読み込む場合にタブを開く時：
	  →特に何もしない。新しく開くタブを子タブにする場合は別途
	    readyToOpenChildTabを使う。

	・現在のサイトと同じサイトのページを読み込む場合にタブを開く時：
	  →親のタブは同じサイトか？
	    No ：子タブを開く
	    Yes：兄弟としてタブを開く。ただし、このタブからのタブはすべて
	         現在のタブと次の兄弟タブとの間に開かれ、仮想サブツリーとなる。
	         →現在のタブに「__autoNewTabHelper__next」プロパティが
	           あるか？
	           Yes：__autoNewTabHelper__nextで示されたタブの直前に
	                新しい兄弟タブを挿入する。
	           No ：現在のタブの次の兄弟タブのIDを__autoNewTabHelper__next
	                プロパティに保持し、仮想の子タブを挿入する位置の
	                基準とする。
*/

		var info = aInfo || { uri : '' };
		try{
			info.uri = this._URIFixup.createFixupURI(info.uri, Ci.nsIURIFixup.FIXUP_FLAG_USE_UTF8);
			info.uri = info.uri.spec || '';
		}
		catch(e) {
		}

		info.uri = this._getShortcutOrURI(info.uri);

		if (/^(javascript|moz-action|mailto):/.test(info.uri))
			return false;

		var frame = this.getFrameFromTabBrowserElements(info.target);
		if (!frame) return false;

		var external = info.external || {};
		var internal = info.internal || {};

		var b       = this.getTabBrowserFromFrame(frame);
		var w       = b.ownerDocument.defaultView;
		var TST     = 'treeStyleTab' in b ? b.treeStyleTab : null ;

		var useEffectiveTLD = 'useEffectiveTLD' in info ? info.useEffectiveTLD : true ;
		var checkUserHome = 'checkUserHome' in info ? info.checkUserHome : true ;

		var targetHost  = this._getDomainFromURI(info.uri, useEffectiveTLD, checkUserHome);
		var currentTab  = this.getTabFromFrame(frame);
		var currentURI  = frame.location.href;
		var currentHost = this._getDomainFromURI(currentURI, useEffectiveTLD, checkUserHome);
		var ownerTab    = TST ?
							TST.getParentTab(currentTab) :
						currentTab ?
							currentTab.owner :
							null ;
		var ownerURI    = ownerTab ? ownerTab.linkedBrowser.currentURI : null ;
		var ownerHost   = this._getDomainFromURI(ownerURI, useEffectiveTLD, checkUserHome);

		var openTab      = false;
		var owner        = null;
		var lastRelated  = null;

		if (
			info.modifier ||
			(
				info.link &&
				info.link instanceof w.Element &&
				info.link.getAttribute(this.kNEW_TAB_READY) == 'true'
			)
			)
			openTab = true;

		var isBlank = w.isBlankPageURL ? w.isBlankPageURL(currentURI) : (currentURI == 'about:blank');
		if (
			internal.newTab &&
			currentHost == targetHost &&
			!this._isRedirectorLink(info.uri, targetHost, currentHost) &&
			!isBlank &&
			currentURI.split('#')[0] != info.uri.split('#')[0]
			) {
			openTab = info.modifier && info.invert ? !openTab : true ;
			owner = ('forceChild' in internal && !internal.forceChild) ? null :
					(ownerHost == targetHost && !internal.forceChild) ? ownerTab :
					this.getTabFromFrame(frame) ;
			let nextTab = TST ?
							TST.getNextSiblingTab(currentTab) :
							this._getNextVisibleTab(currentTab) ;
			let insertNewChildAtFirst = false;
			if (TST) {
				try {
					insertNewChildAtFirst = this.getPref('extensions.treestyletab.insertNewChildAt') == 0;
				}
				catch(e) {
				}
			}
			let insertBefore = ownerHost == targetHost && !internal.forceChild &&
					(insertNewChildAtFirst ?
						nextTab :
						(
							this._getTabById(currentTab.__autoNewTabHelper__next, b) ||
							(nextTab ? (currentTab.__autoNewTabHelper__next = this._getTabId(nextTab), nextTab) : null )
						)
					);
			lastRelated = insertBefore ? insertBefore.previousSibling : null ;
		}
		else if (
			external.newTab &&
			(
				currentHost != targetHost || 
				this._isRedirectorLink(info.uri, targetHost, currentHost)
			) &&
			!isBlank
			) {
			openTab = info.modifier && info.invert ? !openTab : true ;
			if (external.forceChild)
				owner = this.getTabFromFrame(frame);
		}

		return {
			open           : openTab,
			owner          : owner,
			lastRelatedTab : lastRelated,
			tabbrowser     : b
		};
	},
	
	_getShortcutOrURI : function OLITUtils__getShortcutOrURI(aURI) 
	{
		if (this.browserWindow.getShortcutOrURI) // Firefox 24 and older
			return this.browserWindow.getShortcutOrURI(aURI);

		var getShortcutOrURIAndPostData = this.browserWindow.getShortcutOrURIAndPostData;
		var done = false;
		if (getShortcutOrURIAndPostData.length == 2) {
			// Firefox 31 and later, after https://bugzilla.mozilla.org/show_bug.cgi?id=989984
			getShortcutOrURIAndPostData(aURI, function(aData) {
				aURI = aData.url;
				done = true;
			});
		}
		else {
			// Firefox 25-30
			let Task = this._Task;
			Task.spawn(function() {
				var data = yield getShortcutOrURIAndPostData(aURI);
				aURI = data.url;
				done = true;
			});
		}

		// this should be rewritten in asynchronous style...
		var thread = Cc['@mozilla.org/thread-manager;1'].getService().mainThread;
		while (!done)
		{
			thread.processNextEvent(true);
		}

		return aURI;
	},
 
	_getDomainFromURI : function OLITUtils__getDomainFromURI(aURI, aUseEffectiveTLD, aCheckUserHome) 
	{
		if (!aURI) return null;

		var str = aURI;
		if (str instanceof Ci.nsIURI) str = aURI.spec;

		var userHomePart = aCheckUserHome ? str.match(/^\w+:\/\/[^\/]+(\/~[^\/]+)\//) : '' ;
		if (userHomePart) userHomePart = userHomePart[1];

		if (aUseEffectiveTLD && this._EffectiveTLD) {
			try {
				var uri = aURI;
				if (!(uri instanceof Ci.nsIURI)) uri = this._makeURIFromSpec(uri);
				var domain = this._EffectiveTLD.getBaseDomain(uri, 0);
				if (domain) return domain + userHomePart;
			}
			catch(e) {
			}
		}

		var domainMatchResult = str.match(/^\w+:(?:\/\/)?([^:\/]+)/);
		return domainMatchResult ?
				domainMatchResult[1] + userHomePart :
				null ;
	},
	
	_makeURIFromSpec : function OLITUtils_makeURIFromSpec(aURI) 
	{
		var newURI;
		aURI = aURI || '';
		if (aURI && String(aURI).indexOf('file:') == 0) {
			var fileHandler = this._IOService.getProtocolHandler('file').QueryInterface(Ci.nsIFileProtocolHandler);
			var tempLocalFile = fileHandler.getFileFromURLSpec(aURI);
			newURI = this._IOService.newFileURI(tempLocalFile);
		}
		else {
			if (!/^\w+\:/.test(aURI)) aURI = 'http://'+aURI;
			newURI = this._IOService.newURI(aURI, null, null);
		}
		return newURI;
	},
 
	_isRedirectorLink : function OLITUtils_isRedirectorLink(aURIToOpen, aTargetHost, aCurrentHost) 
	{
		if (aTargetHost != aCurrentHost) return false;

		var isGoogleRedirectLink = /https?:\/\/[^\/]*\.google\.[^\/]+\/url\?/.test(aURIToOpen);
		return isGoogleRedirectLink;
	}
   
};

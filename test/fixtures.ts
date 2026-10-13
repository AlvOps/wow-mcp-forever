/** Minimal stand-ins for Wowhead responses, shaped like the real pages. */

export const ITEM_PAGE = `<!doctype html><html><head>
<title>Defender of Dalaran - Item - World of Warcraft: Forever</title>
<meta name="description" content="Defender of Dalaran is a shield. It is looted from Archmage Arugal.">
</head><body>
<div class="text"><h1>Defender of Dalaran</h1><p>A shield forged for the guardians of the city &amp; its towers.</p></div>
<div id="tabs-generic"></div>
<script>
WH.markup.printHtml("[ul][li]Item Level: 42[\\/li][li]Added in WoW: Forever[\\/li][li]Sells for [money=12345][\\/li][\\/ul]", "infobox-contents-0", {});
new Listview({template: 'npc', id: 'dropped-by', name: WH.TERMS.droppedby, tabs: tabsRelated, parent: 'lkljbjkb574',
  extraCols: [Listview.extraCols.count, Listview.extraCols.percent], sort: ['-percent'],
  data: [{"classification":1,"id":4275,"level":"26","location":[209],"name":"Archmage Arugal","react":[-1,-1],"type":7,"count":12,"outof":100},
         {"id":3914,"level":"24","name":"Rethilgore","count":1,"outof":400}]});
new Listview({template: 'item', id: 'reagent-for', data: [{"classs":4,"id":279842,"level":45,"name":"3Battle Spaulders","reqlevel":40,"slot":3}]});
</script></body></html>`;

export const SUGGESTIONS = {
  search: 'defender',
  results: [
    { type: 3, id: 279841, name: 'Defender of Dalaran', quality: 3, typeName: 'Item' },
    { type: 1, id: 4275, name: 'Archmage Arugal', typeName: 'NPC' },
    { type: 5, id: 99001, name: 'Defend the Tower &amp; Gate', typeName: 'Quest' },
  ],
};

export const TOOLTIP = {
  name: 'Defender of Dalaran',
  quality: 3,
  icon: 'inv_shield_05',
  tooltip:
    '<table><tr><td><b class="q3">Defender of Dalaran</b><br>Binds when picked up<br><table width="100%"><tr><td>Off Hand</td><th>Shield</th></tr></table>1450 Armor<br>+7 Stamina</td></tr></table>',
};

export const ITEM_XML = `<?xml version="1.0" encoding="UTF-8"?><wowhead><item id="279841">
<name><![CDATA[Defender of Dalaran]]></name><level>42</level><quality id="3">Rare</quality>
<class id="4"><![CDATA[Armor]]></class><subclass id="6"><![CDATA[Shield]]></subclass>
<icon displayId="1">inv_shield_05</icon><inventorySlot id="14">Off Hand</inventorySlot>
<htmlTooltip><![CDATA[<b>Defender of Dalaran</b><br>1450 Armor]]></htmlTooltip>
<json><![CDATA["id":279841,"name":"Defender of Dalaran","level":42,"reqlevel":37]]></json>
<jsonEquip><![CDATA["armor":1450,"sta":7]]></jsonEquip>
</item></wowhead>`;

/** Shape (A) item stats + shape "data: <variable>" rows, as on /forever/items/weapons/one-handed-swords. */
export const SWORDS_HTML = `<html><head><title>Forever One-Handed Swords</title>
<link rel="canonical" href="https://www.wowhead.com/forever/items/weapons/one-handed-swords/min-req-level:0/max-req-level:20"></head><body>
<script>WH.Gatherer.addData(3, 16, {"100":{"name_enus":"Blade {of} Braces","quality":3,"icon":"inv_sword_07","jsonequip":{"appearances":{"0":[19835,""]},"dps":20.5,"speed":2.3,"dmgmin1":30,"dmgmax1":64,"mledps":20.5,"dura":90,"reqlevel":18,"sta":5,"agi":3,"sellprice":9792}},"101":{"name_enus":"Notched Shortsword","quality":2,"jsonequip":{"dps":12.25,"speed":2.1,"dmgmin1":10,"dmgmax1":20,"reqlevel":8}},"102":{"name_enus":"Worn Shortsword","quality":1,"jsonequip":{"dps":3.1,"speed":1.9,"dmgmin1":2,"dmgmax1":4}},"103":{"name_enus":"Monster - Training Sword","quality":1,"jsonequip":{"reqlevel":4}}});
WH.Gatherer.addData(29, 16, {"1":{"name":"inv_sword_07","icon":"inv_sword_07"}});
var tabsGroups = new Tabs({parent: WH.ge('x')});
var listviewitems = [{"classs":2,"id":100,"level":23,"name":"Blade {of} Braces","quality":3,"slot":13,"source":[2],"sourcemore":[{"n":"Hogger","t":1,"ti":448,"z":12}],"speed":2.30,"subclass":7,firstseenpatch: 0,popularity:5},
{"classs":2,"id":101,"level":10,"name":"Notched Shortsword","quality":2,"reqlevel":8,"slot":13,"source":[5],"sourcemore":[{"n":"Brammold Deepmine","t":1,"z":12}],"speed":2.10,"subclass":7,firstseenpatch: 0,popularity:9},
{"classs":2,"id":101,"level":10,"name":"Notched Shortsword","quality":2,"reqlevel":8,"slot":13,"bonuses":[12719],"parentListviewRowItem":101,popularity:9},
{"classs":2,"id":102,"level":2,"name":"Worn Shortsword","quality":1,"slot":21,"source":[2],"subclass":7,popularity:3},
{"classs":2,"id":103,"level":44,"name":"Monster - Training Sword","quality":1,"slot":21,"subclass":7,popularity:1}];
Filter.init({"page":"items","facets":[{"id":"name","type":"text"},{"id":"min-req-level","type":"text"},{"id":"max-req-level","type":"text"},{"id":"quality","type":"select"},{"id":"item-finder-button","type":"html"}],"activeFacets":{"min-req-level":{"id":"min-req-level","value":"0"},"max-req-level":{"id":"max-req-level","value":20}},"activeFilters":[]});
new Listview({template: 'item', id: 'items', name: WH.TERMS.name, tabs: tabsGroups, hiddenCols: ["type"], customFilter:WH.Page.Items.parentItemFilter,data: listviewitems});
new Listview({template: 'generic-model', id: 'itemsgallery', tabs: tabsGroups, data: WH.cOr([], listviewitems)});
</script></body></html>`;

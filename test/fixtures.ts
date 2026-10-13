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

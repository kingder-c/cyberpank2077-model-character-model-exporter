local OUT_PATHS = {
  "runtime-dump.json",
  "plugins/cyber_engine_tweaks/mods/cp2077_v_dump/runtime-dump.json",
  "D:/Program Files (x86)/Steam/steamapps/common/Cyberpunk 2077/bin/x64/plugins/cyber_engine_tweaks/mods/cp2077_v_dump/runtime-dump.json",
  "E:/2077model/nuxt-web/.cache/cet-v-runtime-dump.json",
}

local dumped = false
local elapsed = 0.0

local function escape_json(value)
  value = tostring(value or "")
  value = value:gsub("\\", "\\\\")
  value = value:gsub("\"", "\\\"")
  value = value:gsub("\n", "\\n")
  value = value:gsub("\r", "\\r")
  value = value:gsub("\t", "\\t")
  return value
end

local function json_string(value)
  return "\"" .. escape_json(value) .. "\""
end

local function safe_value(fn)
  local ok, value = pcall(fn)
  if ok then
    return {
      ok = true,
      value = tostring(value),
      valueType = type(value),
    }
  end
  return {
    ok = false,
    error = tostring(value),
  }
end

local discovered_records = {}

local function note_item_record(value)
  local record = tostring(value or ""):match("(Items%.[A-Za-z0-9_]+)")
  if record then
    discovered_records[record] = true
    return record
  end
  return ""
end

local function encode_object(map)
  local parts = {}
  for key, value in pairs(map) do
    if type(value) == "boolean" then
      table.insert(parts, json_string(key) .. ":" .. tostring(value))
    else
      table.insert(parts, json_string(key) .. ":" .. json_string(value))
    end
  end
  return "{" .. table.concat(parts, ",") .. "}"
end

local function encode_array(items)
  return "[" .. table.concat(items, ",") .. "]"
end

local function probe_object(name, fn)
  local result = {
    name = name,
  }
  local ok, value = pcall(fn)
  result.ok = ok
  if ok then
    result.value = tostring(value)
    result.valueType = type(value)
    if value ~= nil then
      local dump = safe_value(function()
        return Dump(value, false)
      end)
      result.dumpOk = dump.ok
      result.dump = dump.value or ""
      result.dumpError = dump.error or ""
    end
  else
    result.error = tostring(value)
  end
  return encode_object(result)
end

local function get_equipment_system()
  local container = Game.GetScriptableSystemsContainer()
  local attempts = {
    function()
      return container:Get(CName.new("EquipmentSystem"))
    end,
    function()
      return container:Get("EquipmentSystem")
    end,
  }
  for _, attempt in ipairs(attempts) do
    local ok, value = pcall(attempt)
    if ok and value ~= nil then
      return value
    end
  end
  return nil
end

local function probe_slot(ts, player, slot)
  local result = {
    slot = slot,
  }

  local ok_item, item_obj = pcall(function()
    return ts:GetItemInSlot(player, TweakDBID.new(slot))
  end)
  local item = {
    ok = ok_item,
    value = ok_item and tostring(item_obj) or nil,
    error = ok_item and nil or tostring(item_obj),
    valueType = ok_item and type(item_obj) or nil,
  }
  result.getItemInSlotOk = item.ok
  result.item = item.value or ""
  result.itemError = item.error or ""
  result.itemRecord = note_item_record(item.value)

  local stack = safe_value(function()
    return ts:GetItemInSlot(player, TweakDBID.new(slot)):GetTDBID().value
  end)
  result.tweakDbIdOk = stack.ok
  result.tweakDbId = stack.value or ""
  result.tweakDbIdError = stack.error or ""

  local active = safe_value(function()
    return ts:GetActiveItemInSlot(player, TweakDBID.new(slot))
  end)
  result.activeItemOk = active.ok
  result.activeItem = active.value or ""
  result.activeItemError = active.error or ""
  result.activeItemRecord = note_item_record(active.value)

  local itemDump = safe_value(function()
    return Dump(ts:GetItemInSlot(player, TweakDBID.new(slot)), false)
  end)
  result.itemDumpOk = itemDump.ok
  result.itemDump = itemDump.value or ""
  result.itemDumpError = itemDump.error or ""
  note_item_record(itemDump.value)

  if ok_item and item_obj ~= nil then
    local itemId = safe_value(function() return item_obj:GetItemID() end)
    result.objectItemIdOk = itemId.ok
    result.objectItemId = itemId.value or ""
    result.objectItemIdError = itemId.error or ""
    result.objectItemRecord = note_item_record(itemId.value)

    local name = safe_value(function() return item_obj:GetName() end)
    result.objectNameOk = name.ok
    result.objectName = name.value or ""
    result.objectNameError = name.error or ""

    local appearance = safe_value(function() return item_obj:GetCurrentAppearanceName() end)
    result.objectAppearanceOk = appearance.ok
    result.objectAppearance = appearance.value or ""
    result.objectAppearanceError = appearance.error or ""

    local colorVariant = safe_value(function() return item_obj:GetCurrentColorVariantName() end)
    result.objectColorVariantOk = colorVariant.ok
    result.objectColorVariant = colorVariant.value or ""
    result.objectColorVariantError = colorVariant.error or ""

    local itemData = safe_value(function() return item_obj:GetItemData() end)
    result.objectItemDataOk = itemData.ok
    result.objectItemData = itemData.value or ""
    result.objectItemDataError = itemData.error or ""
  end

  return encode_object(result)
end

local function enrich_item_id_object(result, prefix, ts, player, item_id)
  local ok_obj, item_obj = pcall(function()
    return ts:GetItemInSlotByItemID(player, item_id)
  end)
  result[prefix .. "ObjectOk"] = ok_obj
  result[prefix .. "Object"] = ok_obj and tostring(item_obj) or ""
  result[prefix .. "ObjectError"] = ok_obj and "" or tostring(item_obj)
  if not ok_obj or item_obj == nil then
    return
  end

  local name = safe_value(function() return item_obj:GetName() end)
  result[prefix .. "ObjectNameOk"] = name.ok
  result[prefix .. "ObjectName"] = name.value or ""
  result[prefix .. "ObjectNameError"] = name.error or ""

  local appearance = safe_value(function() return item_obj:GetCurrentAppearanceName() end)
  result[prefix .. "ObjectAppearanceOk"] = appearance.ok
  result[prefix .. "ObjectAppearance"] = appearance.value or ""
  result[prefix .. "ObjectAppearanceError"] = appearance.error or ""

  local colorVariant = safe_value(function() return item_obj:GetCurrentColorVariantName() end)
  result[prefix .. "ObjectColorVariantOk"] = colorVariant.ok
  result[prefix .. "ObjectColorVariant"] = colorVariant.value or ""
  result[prefix .. "ObjectColorVariantError"] = colorVariant.error or ""
end

local function enum_area(area_name)
  return Enum.new("gamedataEquipmentArea", area_name)
end

local function probe_equip_area(es, player, area_name, slot_index)
  local result = {
    area = area_name,
    slotIndex = slot_index,
  }
  local item = safe_value(function()
    return es:GetItemInEquipSlot(player, enum_area(area_name), slot_index)
  end)
  result.itemOk = item.ok
  result.item = item.value or ""
  result.itemError = item.error or ""
  result.itemRecord = note_item_record(item.value)
  if item.ok then
    local ok_id, item_id = pcall(function()
      return es:GetItemInEquipSlot(player, enum_area(area_name), slot_index)
    end)
    if ok_id and item_id ~= nil then
      enrich_item_id_object(result, "item", Game.GetTransactionSystem(), player, item_id)
    end
  end

  local active = safe_value(function()
    return es:GetActiveItem(player, enum_area(area_name))
  end)
  result.activeOk = active.ok
  result.active = active.value or ""
  result.activeError = active.error or ""
  result.activeRecord = note_item_record(active.value)
  if active.ok then
    local ok_id, item_id = pcall(function()
      return es:GetActiveItem(player, enum_area(area_name))
    end)
    if ok_id and item_id ~= nil then
      enrich_item_id_object(result, "active", Game.GetTransactionSystem(), player, item_id)
    end
  end

  local visual = safe_value(function()
    return es:GetActiveVisualItem(player, enum_area(area_name))
  end)
  result.visualOk = visual.ok
  result.visual = visual.value or ""
  result.visualError = visual.error or ""
  result.visualRecord = note_item_record(visual.value)
  if visual.ok then
    local ok_id, item_id = pcall(function()
      return es:GetActiveVisualItem(player, enum_area(area_name))
    end)
    if ok_id and item_id ~= nil then
      enrich_item_id_object(result, "visual", Game.GetTransactionSystem(), player, item_id)
    end
  end

  return encode_object(result)
end

local function probe_flat(record, field)
  local full = record .. "." .. field
  local value = safe_value(function()
    return TweakDB:GetFlat(full)
  end)
  return encode_object({
    flat = full,
    ok = value.ok,
    value = value.value or "",
    error = value.error or "",
    valueType = value.valueType or "",
  })
end

local function dump_runtime()
  local player = Game.GetPlayer()
  local ts = Game.GetTransactionSystem()
  local es = get_equipment_system()
  local slots = {
    "AttachmentSlots.Head",
    "AttachmentSlots.Face",
    "AttachmentSlots.OuterChest",
    "AttachmentSlots.InnerChest",
    "AttachmentSlots.Legs",
    "AttachmentSlots.Feet",
    "AttachmentSlots.Outfit",
    "AttachmentSlots.WeaponRight",
    "AttachmentSlots.WeaponLeft",
    "AttachmentSlots.WeaponLeftCyberware",
    "AttachmentSlots.QuickSlot",
    "AttachmentSlots.VehicleWeapon",
  }

  local slot_json = {}
  for _, slot in ipairs(slots) do
    table.insert(slot_json, probe_slot(ts, player, slot))
  end

  local equip_area_json = {}
  if es ~= nil then
    local areas = {
      "Head",
      "Face",
      "ChestArmor",
      "InnerChest",
      "Legs",
      "Feet",
      "Outfit",
      "Weapon",
      "QuickSlot",
    }
    for _, area in ipairs(areas) do
      for slot_index = 0, 2 do
        table.insert(equip_area_json, probe_equip_area(es, player, area, slot_index))
      end
    end
  end

  local runtime_object_json = {
    probe_object("player", function() return player end),
    probe_object("transactionSystem", function() return ts end),
    probe_object("equipmentSystem", function() return es end),
    probe_object("playerState", function() return player:GetPS() end),
    probe_object("quickSlotsManager", function() return player:GetQuickSlotsManager() end),
    probe_object("equipmentPlayerData", function() return es:GetPlayerData(player) end),
    probe_object("inventoryManager", function() return es:GetInventoryManager(player) end),
  }

  local type_json = {
    encode_object({ name = "PlayerPuppet", dump = safe_value(function() return DumpType("PlayerPuppet", false) end).value or "" }),
    encode_object({ name = "gameTransactionSystem", dump = safe_value(function() return DumpType("gameTransactionSystem", false) end).value or "" }),
    encode_object({ name = "EquipmentSystem", dump = safe_value(function() return DumpType("EquipmentSystem", false) end).value or "" }),
    encode_object({ name = "EquipmentSystemPlayerData", dump = safe_value(function() return DumpType("EquipmentSystemPlayerData", false) end).value or "" }),
    encode_object({ name = "InventoryDataManagerV2", dump = safe_value(function() return DumpType("InventoryDataManagerV2", false) end).value or "" }),
    encode_object({ name = "QuickSlotsManager", dump = safe_value(function() return DumpType("QuickSlotsManager", false) end).value or "" }),
    encode_object({ name = "gameItemObject", dump = safe_value(function() return DumpType("gameItemObject", false) end).value or "" }),
    encode_object({ name = "gameItemData", dump = safe_value(function() return DumpType("gameItemData", false) end).value or "" }),
    encode_object({ name = "gameItemID", dump = safe_value(function() return DumpType("gameItemID", false) end).value or "" }),
    encode_object({ name = "gamedataEquipmentArea", dump = safe_value(function() return DumpType("gamedataEquipmentArea", false) end).value or "" }),
    encode_object({ name = "ItemID", dump = safe_value(function() return DumpType("ItemID", false) end).value or "" }),
  }

  local sample_records = {
    "Items.Q001_Pants",
    "Items.Q001_Shoes",
    "Items.Q001_TShirt",
    "Items.GOG_DLC_Jacket",
    "Items.Preset_Q001_Lexington",
  }
  for record, _ in pairs(discovered_records) do
    table.insert(sample_records, record)
  end
  local sample_fields = {
    "entityName",
    "appearanceName",
    "displayName",
    "localizedName",
    "equipArea",
    "placementSlots",
    "visualTags",
    "itemType",
    "itemCategory",
    "quality",
  }
  local flat_json = {}
  for _, record in ipairs(sample_records) do
    for _, field in ipairs(sample_fields) do
      table.insert(flat_json, probe_flat(record, field))
    end
  end

  local top = {
    json_string("generatedAt") .. ":" .. json_string(os.date("!%Y-%m-%dT%H:%M:%SZ")),
    json_string("mod") .. ":" .. json_string("cp2077-v-dump"),
    json_string("player") .. ":" .. encode_object({
      exists = player ~= nil,
      value = tostring(player),
      isNaked = safe_value(function() return player:IsNaked() end).value or "",
      isMoving = safe_value(function() return player:IsMoving() end).value or "",
    }),
    json_string("slots") .. ":" .. encode_array(slot_json),
    json_string("equipAreas") .. ":" .. encode_array(equip_area_json),
    json_string("runtimeObjects") .. ":" .. encode_array(runtime_object_json),
    json_string("typeDumps") .. ":" .. encode_array(type_json),
    json_string("sampleFlats") .. ":" .. encode_array(flat_json),
  }

  local payload = "{" .. table.concat(top, ",") .. "}"
  local wrote = false
  for _, out_path in ipairs(OUT_PATHS) do
    local file = io.open(out_path, "w")
    if file then
      file:write(payload)
      file:close()
      print("[cp2077-v-dump] wrote " .. out_path)
      wrote = true
      break
    end
    print("[cp2077-v-dump] failed to open " .. out_path)
  end

  if not wrote then
    print("[cp2077-v-dump] all output paths failed")
  end
end

registerForEvent("onInit", function()
  print("[cp2077-v-dump] loaded")
end)

registerForEvent("onUpdate", function(delta)
  if dumped then
    return
  end
  elapsed = elapsed + delta
  if elapsed < 5.0 then
    return
  end
  dumped = true
  local ok, err = pcall(dump_runtime)
  if not ok then
    print("[cp2077-v-dump] error: " .. tostring(err))
  end
end)

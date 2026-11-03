"use strict";

/**
 * Static Primus-style accessorial choices for email confirm typeaheads.
 * Mirrors functions/quote-accessorial-catalog STATIC_SECTIONS (names only).
 * Live codes come from getDashboardAccessorials when the page can fetch it.
 */

const STATIC_CHOICES = [
  {
    "code": "",
    "name": "Additional Accessorials",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Additional Invoice",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Additional Pallets",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Additional Skids",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Adminstrative Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Adult Signature Required",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "After Hours Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "After Hours Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "After Hours Service",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Airport Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Airport Drop/Recovery",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Airport Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Airport Transfer Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Airport Transfer Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Alcoholic Beverage Reporting Charge",
    "category": "Other"
  },
  {
    "code": "",
    "name": "AN Fees",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Appointment at Destination",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Appointment at Origin",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Attempt Pickup",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Attempted Delivery",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Blind Shipment",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Bobtail",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Bond and Service Charges",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Camp/Park/Resort Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Camp/Park/Resort Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Carm Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "CARM Setup Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "CFS Fees",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Change in dims",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Chargeback",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Chassis Rental",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Chassis Split",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Church Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Church Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "CIT Disbursement Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "COD",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Commission - Carrier",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Construction Site Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Construction Site Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Container Lift",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Container Station in Destination",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Container Station in Origin",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Continuous Bond",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Credit Card Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "CTF",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Custom Accessorials",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Customs Broker Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Customs Entry Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Delivery Appointment",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Delivery During Non Business Hours",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Demurrage",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Detention",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Detention Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Detention Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Direct Signature Required",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Discount",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Distribution Center Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Dock Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Dock Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Driver Labor",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Drop Container",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Dump Truck",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Duties",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Empty Pallets",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Exam Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Exhibition Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Exhibition Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Extra Man Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Extra Man Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Fair Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Fair Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Farm/Ranch Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Farm/Ranch Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "FCCOD",
    "category": "Other"
  },
  {
    "code": "",
    "name": "FDA Filling Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Final Delivery",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Freight",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Fuel Surcharge",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Furniture Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Gate Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Government Destination",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Government Origin",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Grocery Warehouse Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "GST",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Guaranteed Delivery",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Hazardous Material",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Hold for Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Hold for Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Holiday Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Holiday Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Hospital Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Hospital Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Hotel Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Hotel Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Inbond Charge",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Inbound Loading",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Inbound per Pallet",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Inside Delivery",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Inside Destination",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Inside Origin",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Inspection Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Insurance",
    "category": "Other"
  },
  {
    "code": "",
    "name": "ISC",
    "category": "Other"
  },
  {
    "code": "",
    "name": "ISF Filing Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Labeling",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Labeling Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Labor",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Late Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Layover",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Liftgate at Destination",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Liftgate at Origin",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Limited Access Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Limited Access Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Lumper",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Mall Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Mall Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Military Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Military Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Military Site",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Mine Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Mine Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "New Jersey Alcoholic Bev Rpt Charge",
    "category": "Other"
  },
  {
    "code": "",
    "name": "New Pickup",
    "category": "Other"
  },
  {
    "code": "",
    "name": "New York Garment Area",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Notification Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Notification Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Notify",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Nursing Home Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Nursing Home Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Off Hire Charge",
    "category": "Other"
  },
  {
    "code": "",
    "name": "OGD",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Order Processing",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Outbound Loading",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Outbound per Carton",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Outbound Per Pallet",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Oversize > 7ft.",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Overweight Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Packaging Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Pallet Exchange",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Pallet Exchange Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Pallet Exchange Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Pallet Jack",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Pallet Jack Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Pallet Jack Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Palletize",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Per Diem",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Pickup Appointment",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Pier or Port Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Pier or Port Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Pier Pass",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Port Check",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Power Plant / Nuclear",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Pre Pull",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Prepull",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Prison Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Prison Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Protect from Freezing",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Protect from heat",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Re Weigh/Weight Verification",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Reclass",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Reconsignment",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Redelivery",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Redelivery Fee",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Reefer",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Residential Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Residential Delivery Signature Required",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Residential Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Reweigh",
    "category": "Other"
  },
  {
    "code": "",
    "name": "RM Usage Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Rush Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Saturday Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Saturday Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "School Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "School Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Security Inspection",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Self Storage Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Self Storage Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Settlement",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Shrink Wrap",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Sima",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Single Shipment",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Single Shipment Fee",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Sort and Seg",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Sorting/Segregating Destination",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Sorting/Segregating Origin",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Special Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Special Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Steel Mill Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Steel Mill Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Stop off",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Storage",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Sunday Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Sunday Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "test",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Time Specific",
    "category": "Other"
  },
  {
    "code": "",
    "name": "TMF",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Tolls",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Trailer Delivery",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Transload",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Truck Ordered Not Used",
    "category": "Other"
  },
  {
    "code": "",
    "name": "TSA Qualified Driver Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "TSA Qualified Driver Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Unpack",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Vendor Declared Value",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Warehousing",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Wash House Delivery",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Weekend Delivery",
    "category": "Destination"
  },
  {
    "code": "",
    "name": "Weekend Pickup",
    "category": "Origin"
  },
  {
    "code": "",
    "name": "Weekend Service",
    "category": "Other"
  },
  {
    "code": "",
    "name": "Xtreme Assurance",
    "category": "Other"
  }
];

/**
 * @return {Array<{code: string, name: string, category: string}>}
 */
function staticAccessorialChoices() {
  return STATIC_CHOICES.map((row) => ({
    code: row.code || "",
    name: row.name,
    category: row.category || "Other",
  }));
}

module.exports = {staticAccessorialChoices};

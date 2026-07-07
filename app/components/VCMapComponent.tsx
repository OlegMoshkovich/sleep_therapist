import React, { useEffect, useRef, useState } from 'react';

// Dynamically import Leaflet only on client side
const L = typeof window !== 'undefined' ? require('leaflet') : null;

const VCMapComponent = () => {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef<any>(null);
  const [isClient, setIsClient] = useState(false);
  const [isLegendOpen, setIsLegendOpen] = useState(true);
  const [selectedTiers, setSelectedTiers] = useState([1, 2, 3, 4]); // Show all tiers by default
  const markersRef = useRef<Array<{ marker: any; tier: number }>>([]);

  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    // Initialize map only once and only on client side
    if (!isClient || !L || mapInstanceRef.current) return;

    // Initialize map centered on London
    const map = L.map(mapRef.current).setView([51.5074, -0.1278], 12);
    mapInstanceRef.current = map;

    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    // Define marker colors by tier
    const tierColors: { [key: number]: string } = {
      1: '#dc2626',
      2: '#ea580c',
      3: '#2563eb',
      4: '#16a34a'
    };

    // VC firm data with coordinates
    const vcFirms = [
      {
        name: 'Air Street Capital',
        tier: 1,
        lat: 51.5116,
        lng: -0.0781,
        address: '64-66 Crutched Friars, London EC3N 2DN',
        website: 'https://www.airstreet.com',
        partner: 'Nathan Benaich',
        partnerLinkedIn: 'https://www.linkedin.com/in/nathanbenaich/',
        checkSize: '£1M - £5M',
        fitScore: 10,
        priority: 'High'
      },
      {
        name: 'Plural Platform',
        tier: 1,
        lat: 51.5134,
        lng: -0.0890,
        address: '1 Poultry, London EC2R 8EJ',
        website: 'https://www.pluralplatform.com',
        partner: 'Ian Hogarth / Taavet Hinrikus',
        partnerLinkedIn: 'https://www.linkedin.com/in/ianhogarth/',
        checkSize: '£5M - £20M',
        fitScore: 9,
        priority: 'High'
      },
      {
        name: 'Index Ventures',
        tier: 1,
        lat: 51.5139,
        lng: -0.0782,
        address: '6 Bevis Marks, London EC3A 7BA',
        website: 'https://www.indexventures.com',
        partner: 'Hannah Seal',
        partnerLinkedIn: 'https://www.linkedin.com/in/hannah-seal-69154140/',
        checkSize: '£5M - £30M+',
        fitScore: 9,
        priority: 'High'
      },
      {
        name: 'Entrepreneur First',
        tier: 2,
        lat: 51.5212,
        lng: -0.1383,
        address: '41-42 Foley Street, London W1W 7TS',
        website: 'https://www.joinef.com',
        partner: 'Matt Clifford',
        partnerLinkedIn: 'https://www.linkedin.com/in/matthewclifford/',
        checkSize: '£1M - £7M',
        fitScore: 9,
        priority: 'High'
      },
      {
        name: 'Amadeus Capital',
        tier: 2,
        lat: 51.5069,
        lng: -0.1329,
        address: '10 St James\'s Square, London SW1Y 4LE',
        website: 'https://www.amadeuscapital.com',
        partner: 'TBD',
        partnerLinkedIn: '',
        checkSize: '£1M - £5M',
        fitScore: 8,
        priority: 'High'
      },
      {
        name: 'LocalGlobe',
        tier: 2,
        lat: 51.5067,
        lng: -0.1076,
        address: '1-2 Paris Garden, London SE1 8ND',
        website: 'https://localglobe.vc',
        partner: 'TBD',
        partnerLinkedIn: '',
        checkSize: '£500k - £5M',
        fitScore: 8,
        priority: 'High'
      },
      {
        name: 'Balderton Capital',
        tier: 2,
        lat: 51.5151,
        lng: -0.0877,
        address: '41 Lothbury, London EC2R 7HG',
        website: 'https://www.balderton.com',
        partner: 'James Wise',
        partnerLinkedIn: 'https://www.linkedin.com/in/jameswise/',
        checkSize: '£3M - £15M',
        fitScore: 7,
        priority: 'Medium'
      },
      {
        name: 'Atomico',
        tier: 2,
        lat: 51.5152,
        lng: -0.1064,
        address: '5 New Street Square, London EC4A 3TW',
        website: 'https://www.atomico.com',
        partner: 'Ben Blume',
        partnerLinkedIn: 'https://www.linkedin.com/in/benblume/',
        checkSize: '£5M - £20M',
        fitScore: 7,
        priority: 'Medium'
      },
      {
        name: 'Accel',
        tier: 1,
        lat: 51.5134,
        lng: -0.0763,
        address: '5 Lloyds Avenue, London EC3N 3AE',
        website: 'https://www.accel.com',
        partner: 'Andrei Brasoveanu',
        partnerLinkedIn: 'https://www.linkedin.com/in/andreib/',
        checkSize: '£5M - £20M',
        fitScore: 6,
        priority: 'Medium'
      },
      {
        name: 'GV (Corporate)',
        tier: 3,
        lat: 51.5358,
        lng: -0.1245,
        address: '6 Pancras Square, London N1C 4AG',
        website: 'https://www.gv.com',
        partner: 'TBD',
        partnerLinkedIn: '',
        checkSize: '$5M - $20M',
        fitScore: 7,
        priority: 'Medium'
      },
      {
        name: 'Notion Capital',
        tier: 2,
        lat: 51.5151,
        lng: -0.1044,
        address: '20 Farringdon Street, London EC4A 4AB',
        website: 'https://www.notion.vc',
        partner: 'TBD',
        partnerLinkedIn: '',
        checkSize: '£4M - £10M',
        fitScore: 4,
        priority: 'Low'
      },
      {
        name: 'Mosaic Ventures',
        tier: 2,
        lat: 51.5205,
        lng: -0.1568,
        address: '54 Baker Street, London W1U 7BU',
        website: 'https://www.mosaicventures.com',
        partner: 'TBD',
        partnerLinkedIn: '',
        checkSize: 'TBD',
        fitScore: 4,
        priority: 'Low'
      },
      {
        name: 'Passion Capital',
        tier: 2,
        lat: 51.5254,
        lng: -0.0864,
        address: '70 Wilson Street, London EC2A 2DB',
        website: 'https://www.passioncapital.com',
        partner: 'TBD',
        partnerLinkedIn: '',
        checkSize: '£1M - £3M',
        fitScore: 3,
        priority: 'Low'
      },
      {
        name: 'Sovereign AI Unit',
        tier: 4,
        lat: 51.4969,
        lng: -0.1296,
        address: '10 Victoria Street, London SW1H 0NB',
        website: 'https://www.gov.uk',
        partner: 'James Wise (Chair)',
        partnerLinkedIn: 'https://www.linkedin.com/in/jameswise/',
        checkSize: '£500M Fund',
        fitScore: 10,
        priority: 'High'
      },
      {
        name: 'NVIDIA (Strategic)',
        tier: 3,
        lat: 51.5177,
        lng: -0.0854,
        address: '201 Bishopsgate, London EC2M 3AE',
        website: 'https://www.nvidia.com',
        partner: 'TBD',
        partnerLinkedIn: '',
        checkSize: '£2B Investment',
        fitScore: 9,
        priority: 'High'
      }
    ];

    // Create custom icon function
    const createCustomIcon = (tier: number) => {
      return L.divIcon({
        className: 'custom-marker',
        html: `<div style="
          background-color: ${tierColors[tier]};
          width: 20px;
          height: 20px;
          border-radius: 50%;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        "></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
    };

    // Add markers for each VC firm and store references
    markersRef.current = [];
    vcFirms.forEach(firm => {
      const priorityClass = `priority-${firm.priority.toLowerCase()}`;
      
      let popupContent = `
        <div class="vc-popup-content">
          <h3>${firm.name}</h3>
          <p><strong>Address:</strong> ${firm.address}</p>
          <p><strong>Check Size:</strong> ${firm.checkSize}</p>
          <p><strong>Partner:</strong> ${firm.partner}${firm.partnerLinkedIn ? ` <a href="${firm.partnerLinkedIn}" target="_blank" rel="noopener noreferrer">LinkedIn</a>` : ''}</p>
          <p>
            <span class="popup-score">Fit: ${firm.fitScore}/10</span>
            <span class="popup-priority ${priorityClass}">${firm.priority}</span>
          </p>
          <p><a href="${firm.website}" target="_blank" rel="noopener noreferrer">Visit Website →</a></p>
        </div>
      `;

      const marker = L.marker([firm.lat, firm.lng], {
        icon: createCustomIcon(firm.tier)
      }).addTo(map);

      marker.bindPopup(popupContent);
      
      // Store marker with tier info for filtering
      markersRef.current.push({
        marker: marker,
        tier: firm.tier
      });
    });

    // Fit map to show all markers
    const group = L.featureGroup(vcFirms.map(firm => 
      L.marker([firm.lat, firm.lng])
    ));
    map.fitBounds(group.getBounds().pad(0.1));

    // Cleanup function
    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [isClient]);

  // Filter markers based on selected tiers
  useEffect(() => {
    if (markersRef.current.length > 0 && mapInstanceRef.current) {
      markersRef.current.forEach(({ marker, tier }) => {
        if (selectedTiers.includes(tier)) {
          marker.addTo(mapInstanceRef.current);
        } else {
          mapInstanceRef.current.removeLayer(marker);
        }
      });
    }
  }, [selectedTiers]);

  // Function to toggle tier visibility
  const toggleTier = (tier: number) => {
    setSelectedTiers(prev => {
      if (prev.includes(tier)) {
        return prev.filter(t => t !== tier);
      } else {
        return [...prev, tier];
      }
    });
  };

  // Note: Leaflet CSS should be imported in a layout or CSS file for proper loading


  if (!isClient) {
    return (
      <div style={{ 
        width: '100%', 
        height: '100%',
        minHeight: '400px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f3f4f6'
      }}>
        Loading map...
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div 
        ref={mapRef} 
        style={{ 
          width: '100%', 
          height: '100%',
          minHeight: '400px'
        }} 
      />
      
      <div style={{
        position: 'absolute',
        top: '10px',
        right: '10px',
        background: '#ffffff',
        padding: '15px',
        borderRadius: '4px',
        zIndex: 9999,
        maxWidth: '280px',
        minWidth: '200px'
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          marginBottom: isLegendOpen ? '10px' : '0'
        }}>
          <h3 
            onClick={() => setIsLegendOpen(!isLegendOpen)}
            style={{
              margin: 0,
              fontSize: '16px',
              cursor: 'pointer',
              color: '#000000',
              textAlign: 'center'
            }}
          >
            VC Fund Tiers
          </h3>
        </div>
        
        {isLegendOpen && (
          <div>
            <div 
              style={{ 
                display: 'flex', 
                alignItems: 'center', 
                margin: '5px 0', 
                fontSize: '13px',
                cursor: 'pointer',
                opacity: selectedTiers.includes(1) ? 1 : 0.5,
                transition: 'opacity 0.2s'
              }}
              onClick={() => toggleTier(1)}
            >
              <div style={{
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                marginRight: '8px',
                backgroundColor: '#dc2626',
              }}></div>
              <span style={{ color: '#000000', fontWeight: 500 }}>Tier 1: AI-Focused Seed Lead</span>
            </div>
            
            <div 
              style={{ 
                display: 'flex', 
                alignItems: 'center', 
                margin: '5px 0', 
                fontSize: '13px',
                cursor: 'pointer',
                opacity: selectedTiers.includes(2) ? 1 : 0.5,
                transition: 'opacity 0.2s'
              }}
              onClick={() => toggleTier(2)}
            >
              <div style={{
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                marginRight: '8px',
                backgroundColor: '#ea580c',
              }}></div>
              <span style={{ color: '#000000', fontWeight: 500 }}>Tier 2: Generalist with AI History</span>
            </div>
            
            <div 
              style={{ 
                display: 'flex', 
                alignItems: 'center', 
                margin: '5px 0', 
                fontSize: '13px',
                cursor: 'pointer',
                opacity: selectedTiers.includes(3) ? 1 : 0.5,
                transition: 'opacity 0.2s'
              }}
              onClick={() => toggleTier(3)}
            >
              <div style={{
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                marginRight: '8px',
                backgroundColor: '#2563eb',

              }}></div>
              <span style={{ color: '#000000', fontWeight: 500 }}>Tier 3: Corporate/Strategic</span>
            </div>
            
            <div 
              style={{ 
                display: 'flex', 
                alignItems: 'center', 
                margin: '5px 0', 
                fontSize: '13px',
                cursor: 'pointer',
                opacity: selectedTiers.includes(4) ? 1 : 0.5,
                transition: 'opacity 0.2s'
              }}
              onClick={() => toggleTier(4)}
            >
              <div style={{
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                marginRight: '8px',
                backgroundColor: '#16a34a',
              }}></div>
              <span style={{ color: '#000000', fontWeight: 500 }}>Tier 4: Alternative Funding</span>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .vc-popup-content {
          min-width: 250px;
        }
        .vc-popup-content h3 {
          margin: 0 0 10px 0;
          font-size: 16px;
          color: #1f2937;
        }
        .vc-popup-content p {
          margin: 5px 0;
          font-size: 13px;
          color: #4b5563;
        }
        .vc-popup-content a {
          color: #2563eb;
          text-decoration: none;
          font-weight: 500;
        }
        .vc-popup-content a:hover {
          text-decoration: underline;
        }
        .popup-score {
          display: inline-block;
          background: #10b981;
          color: white;
          padding: 2px 8px;
          border-radius: 4px;
          font-weight: 400;
          font-size: 12px;
        }
        .popup-priority {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 4px;
          font-weight: 400;
          font-size: 12px;
          margin-left: 5px;
        }
        .priority-high {
          background: #dc2626;
          color: white;
        }
        .priority-medium {
          background: #f59e0b;
          color: white;
        }
        .priority-low {
          background: #6b7280;
          color: white;
        }
      `}</style>
    </div>
  );
};

export default VCMapComponent;